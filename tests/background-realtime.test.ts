import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from "../src/shared/settings";
import { createSubtitleCue } from "../src/shared/subtitle";
import type { SubtitleCue, TranslationResponse, TranslationSettings } from "../src/shared/types";

/**
 * Runs the real background worker against a fake Chrome and a fake
 * OpenAI-compatible service whose answers are held until the test releases
 * them.
 *
 * What it guards is the seam between a caption asked for now and the lines
 * prefetched ahead of it: a line is never asked for twice, whichever message
 * lands first; a line the viewer moved past stops costing a request; and a
 * newer caption never waits behind an older one.
 */

interface HeldRequest {
  cue: string;
  stream: boolean;
  /** The earlier lines the request carried as context. */
  context: Array<{ source: string; translation: string }>;
  aborted: () => boolean;
  release: (translation: string) => void;
}

interface SentMessage {
  type: string;
  [key: string]: unknown;
}

type Listener = (
  message: unknown,
  sender: { tab?: { id: number } },
  sendResponse: (response: unknown) => void
) => boolean;

const SETTINGS: TranslationSettings = {
  ...DEFAULT_SETTINGS,
  provider: "openai-compatible",
  apiBaseUrl: "https://llm.example/v1",
  apiKey: "test-key",
  draftCaptions: false
};

function line(text: string, startMs: number, source: SubtitleCue["source"] = "text-track"): SubtitleCue {
  const cue = createSubtitleCue({ source, startMs, endMs: startMs + 2_000, text, isFinal: true });
  if (!cue) {
    throw new Error("empty cue");
  }
  return cue;
}

function sse(text: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

function json(text: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ translation: text, entities: [] }) } }]
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function startWorker(
  options: { sessionWritesHang?: boolean; settings?: Partial<TranslationSettings> } = {}
) {
  const local = new Map<string, unknown>([
    [SETTINGS_STORAGE_KEY, { ...SETTINGS, ...options.settings }]
  ]);
  const session = new Map<string, unknown>();
  const tabMessages: SentMessage[] = [];
  let onMessage: Listener | null = null;

  const area = (store: Map<string, unknown>, writesHang = false) => ({
    get: async (key: string | null) =>
      key === null ? Object.fromEntries(store) : { [key]: store.get(key) },
    set: (items: Record<string, unknown>) => {
      if (writesHang) {
        return new Promise<void>(() => undefined);
      }
      for (const [key, value] of Object.entries(items)) {
        store.set(key, value);
      }
      return Promise.resolve();
    },
    remove: async (keys: string | string[]) => {
      for (const key of [keys].flat()) {
        store.delete(key);
      }
    },
    setAccessLevel: async () => undefined
  });
  const ignored = { addListener: () => undefined };
  vi.stubGlobal("chrome", {
    runtime: {
      onInstalled: ignored,
      onStartup: ignored,
      onMessage: {
        addListener: (listener: Listener) => {
          onMessage = listener;
        }
      }
    },
    storage: {
      local: area(local),
      session: area(session, options.sessionWritesHang),
      onChanged: ignored
    },
    tabs: {
      onRemoved: ignored,
      query: async () => [],
      sendMessage: async (_tabId: number, message: SentMessage) => {
        tabMessages.push(message);
      }
    },
    permissions: { contains: async () => true }
  });

  const requests: HeldRequest[] = [];
  /** Lines sent to DeepL, which answers at once. */
  const deepL: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return Promise.resolve(new Response(null, { status: 405 }));
      }
      if (url.includes("deepl.com")) {
        const [text] = (JSON.parse(String(init?.body)) as { text: string[] }).text;
        deepL.push(text);
        return Promise.resolve(
          new Response(JSON.stringify({ translations: [{ text: `[DeepL] ${text}` }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          })
        );
      }
      const body = JSON.parse(String(init?.body)) as {
        stream?: boolean;
        messages: Array<{ content: string }>;
      };
      const { cue, context } = JSON.parse(body.messages[1].content) as {
        cue: string;
        context: HeldRequest["context"];
      };
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal ?? undefined;
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("The request was aborted.", "AbortError")),
          { once: true }
        );
        requests.push({
          cue,
          stream: body.stream === true,
          context,
          aborted: () => signal?.aborted === true,
          release: (translation) => resolve(body.stream ? sse(translation) : json(translation))
        });
      });
    })
  );

  await import("../src/background/index");
  await vi.advanceTimersByTimeAsync(0);

  const send = (message: SentMessage): Promise<unknown> =>
    new Promise((resolve) => {
      onMessage?.(message, { tab: { id: 7 } }, resolve);
    });

  return {
    requests,
    tabMessages,
    deepL,
    /** A line for the DeepL channel, as the content script asks for it. */
    askDeepL: (text: string, flags: { asFinal: boolean; meeting: boolean }) =>
      send({ type: "DRAFT_TRANSLATE", sessionId: "tab", cueId: text, text, ...flags }),
    /** The user unticks 「在本机保存会议双语记录」, withdrawing consent to a record. */
    withdrawMeetingRecord: () => send({ type: "SAVE_SETTINGS", patch: { meetingTranscript: false } }),
    /** Which lines went to the service, in order. */
    asked: () => requests.map((request) => request.cue),
    translate: (cue: SubtitleCue) =>
      send({ type: "TRANSLATE_CUE", request: { sessionId: "tab", cue } }) as Promise<TranslationResponse>,
    prefetch: (cues: SubtitleCue[]) => send({ type: "PREFETCH_CUES", sessionId: "tab", cues }),
    /** The user picks another target language in the options page. */
    switchTargetTo: (targetLanguage: TranslationSettings["targetLanguage"]) =>
      send({ type: "SAVE_SETTINGS", patch: { targetLanguage } }),
    /** The service answers the newest open request for `text`. */
    async answer(text: string, translation: string) {
      const request = [...requests].reverse().find((held) => held.cue === text && !held.aborted());
      request?.release(translation);
      await vi.advanceTimersByTimeAsync(0);
    },
    settle: () => vi.advanceTimersByTimeAsync(0)
  };
}

describe("the background worker keeps captions in time", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("answers a line prefetched ahead of playback without asking the service again", async () => {
    const worker = await startWorker();
    const first = line("おはよう", 1_000);
    const second = line("いい天気ですね", 4_000);

    await worker.prefetch([first, second]);
    await worker.settle();
    await worker.answer("おはよう", "早上好。");
    await worker.answer("いい天気ですね", "天气真好。");

    const response = await worker.translate(second);

    expect(response).toMatchObject({ ok: true, translation: { text: "天气真好。" } });
    expect(worker.asked()).toEqual(["おはよう", "いい天気ですね"]);
  });

  it("prefetches one line at a time, each with the lines before it as context", async () => {
    const worker = await startWorker();

    await worker.prefetch([line("おはよう", 1_000), line("いい天気ですね", 4_000)]);
    await worker.settle();
    expect(worker.asked()).toEqual(["おはよう"]);

    await worker.answer("おはよう", "早上好。");
    expect(worker.asked()).toEqual(["おはよう", "いい天気ですね"]);
    expect(worker.requests[1]?.context).toEqual([
      expect.objectContaining({ source: "おはよう", translation: "早上好。" })
    ]);
  });

  it("lets a line due now wait for its prefetch instead of asking twice", async () => {
    const worker = await startWorker();
    const first = line("おはよう", 1_000);
    await worker.prefetch([first]);
    await worker.settle();

    const response = worker.translate(first);
    await worker.settle();
    await worker.answer("おはよう", "早上好。");

    await expect(response).resolves.toMatchObject({ ok: true, translation: { text: "早上好。" } });
    expect(worker.asked()).toEqual(["おはよう"]);
  });

  it("never asks for the line on screen twice, whichever message lands first", async () => {
    const worker = await startWorker();
    const onScreen = line("おはよう", 1_000);

    const response = worker.translate(onScreen);
    await worker.settle();
    await worker.prefetch([onScreen, line("いい天気ですね", 4_000)]);
    await worker.settle();

    // The line on screen is being translated live; only the next one is
    // prefetched alongside it.
    expect(worker.asked()).toEqual(["おはよう", "いい天気ですね"]);
    await worker.answer("おはよう", "早上好。");
    await expect(response).resolves.toMatchObject({ ok: true, translation: { text: "早上好。" } });
  });

  it("stops prefetching lines the viewer seeked away from", async () => {
    const worker = await startWorker();
    await worker.prefetch([line("おはよう", 1_000), line("いい天気ですね", 4_000)]);
    await worker.settle();

    await worker.prefetch([line("さようなら", 600_000)]);
    await worker.settle();

    expect(worker.requests[0]?.aborted()).toBe(true);
    expect(worker.asked()).toEqual(["おはよう", "さようなら"]);
  });

  it("does not hold a newer YouTube line behind an older one", async () => {
    const worker = await startWorker();

    const stale = worker.translate(line("一行目", 1_000, "youtube-dom"));
    await worker.settle();
    const newest = worker.translate(line("二行目", 2_000, "youtube-dom"));
    await worker.settle();

    // The newer line is asked for at once; the older one is given up.
    expect(worker.asked()).toEqual(["一行目", "二行目"]);
    await expect(stale).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    await worker.answer("二行目", "第二行。");
    await expect(newest).resolves.toMatchObject({ ok: true, translation: { text: "第二行。" } });
  });

  it("streams a live caption's answer to the tab as it is written", async () => {
    const worker = await startWorker();

    const response = worker.translate(line("おはよう", 1_000, "youtube-dom"));
    await worker.settle();
    expect(worker.requests[0]?.stream).toBe(true);
    await worker.answer("おはよう", "早上好。");
    await response;

    expect(worker.tabMessages).toContainEqual(
      expect.objectContaining({ type: "TRANSLATION_PARTIAL", text: "早上好。" })
    );
  });

  it("returns the caption without waiting for the session to be stored", async () => {
    // A slow storage write is the worker's business, not the viewer's.
    const worker = await startWorker({ sessionWritesHang: true });

    const response = worker.translate(line("おはよう", 1_000));
    await worker.settle();
    await worker.answer("おはよう", "早上好。");

    await expect(response).resolves.toMatchObject({ ok: true, translation: { text: "早上好。" } });
  });

  it("drops a prefetched answer the user switched languages away from while a caption waited on it", async () => {
    const worker = await startWorker();
    const onScreen = line("おはよう", 1_000);
    await worker.prefetch([onScreen]);
    await worker.settle();
    const waiting = worker.translate(onScreen);
    await worker.settle();

    await worker.switchTargetTo("en");
    await worker.answer("おはよう", "早上好。");

    await expect(waiting).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    // Nothing Chinese was kept for the English session: the line is asked
    // for again, in English.
    const again = worker.translate(onScreen);
    await worker.settle();
    expect(worker.asked()).toEqual(["おはよう", "おはよう"]);
    await worker.answer("おはよう", "Good morning.");
    await expect(again).resolves.toMatchObject({ ok: true, translation: { text: "Good morning." } });
  });

  it("drops a live answer the user switched languages away from", async () => {
    const worker = await startWorker();
    const onScreen = line("おはよう", 1_000);
    const live = worker.translate(onScreen);
    await worker.settle();

    await worker.switchTargetTo("en");
    // The next track line is prefetched under the new pair before the old
    // answer comes back.
    await worker.prefetch([line("いい天気ですね", 4_000)]);
    await worker.settle();
    await worker.answer("おはよう", "早上好。");

    await expect(live).resolves.toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    const again = worker.translate(onScreen);
    await worker.settle();
    expect(worker.asked().filter((cue) => cue === "おはよう")).toHaveLength(2);
    await worker.answer("おはよう", "Good morning.");
    await expect(again).resolves.toMatchObject({ ok: true, translation: { text: "Good morning." } });
  });

  it("keeps an episode on DeepL alone out of what withdrawing a meeting record forgets", async () => {
    // DeepL alone on Netflix is asked as the caption itself, like a meeting's
    // channel, but an episode is not a call: withdrawing consent to a meeting
    // record must not cost it the lines it already knows.
    const worker = await startWorker({
      settings: {
        draftCaptions: true,
        draftProvider: "deepl",
        draftApiKey: "deepl-key",
        meetingTranscript: true
      }
    });

    await worker.askDeepL("こんにちは", { asFinal: true, meeting: false });
    await worker.withdrawMeetingRecord();
    const repeat = await worker.askDeepL("こんにちは", { asFinal: true, meeting: false });

    expect(repeat).toEqual({ ok: true, text: "[DeepL] こんにちは" });
    expect(worker.deepL).toEqual(["こんにちは"]);
  });

  it("still forgets a call's lines when consent to its record is withdrawn", async () => {
    const worker = await startWorker({
      settings: {
        draftCaptions: true,
        draftProvider: "deepl",
        draftApiKey: "deepl-key",
        meetingTranscript: true
      }
    });

    await worker.askDeepL("Good morning.", { asFinal: true, meeting: true });
    await worker.withdrawMeetingRecord();
    await worker.askDeepL("Good morning.", { asFinal: true, meeting: true });

    expect(worker.deepL).toEqual(["Good morning.", "Good morning."]);
  });
});

