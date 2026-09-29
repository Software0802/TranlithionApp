import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubtitleController } from "../src/content/subtitle-controller";
import { DEFAULT_SETTINGS, publicSettings } from "../src/shared/settings";
import type {
  PublicTranslationSettings,
  SubtitleCue,
  TranslationResponse
} from "../src/shared/types";

/**
 * Drives a film page end to end — a `<video>` whose text track the real
 * adapter reads, the controller and the overlay — against fakes, with the
 * background's answers held until the test releases them.
 *
 * What it guards is how soon the viewer reads a line: a streamed answer fills
 * in as it arrives, a line whose translation is already waiting goes up
 * without a placeholder flashing first, and the track's next lines are asked
 * for before they are due.
 */

interface FakeCue {
  startTime: number;
  endTime: number;
  text: string;
}

const LINES: FakeCue[] = [
  { startTime: 1, endTime: 3, text: "おはよう" },
  { startTime: 4, endTime: 6, text: "いい天気ですね" },
  { startTime: 7, endTime: 9, text: "散歩しましょう" },
  { startTime: 10, endTime: 12, text: "そうしましょう" },
  { startTime: 13, endTime: 15, text: "行きましょう" }
];

const PLACEHOLDER = "正在翻译…";

interface FakeNode {
  className: string;
  textContent: string;
  [key: string]: unknown;
}

interface SentMessage {
  type: string;
  [key: string]: unknown;
}

function createFixture(
  overrides: Partial<PublicTranslationSettings> = {},
  options: { alreadyTranslated?: Record<string, string> } = {}
) {
  let wallClockMs = 0;
  // Playback is inside the first line when the page is scanned.
  let mediaTimeMs = 2_000;
  const nodes: FakeNode[] = [];
  /** Every text the overlay's translation line has shown, in order. */
  const painted: string[] = [];
  const messages: SentMessage[] = [];
  const asked: SubtitleCue[] = [];
  const held = new Map<string, (response: TranslationResponse) => void>();

  function answerFor(text: string): TranslationResponse {
    return {
      ok: true,
      translation: { text, provider: "openai-compatible", latencyMs: 1, entityHints: [] }
    };
  }

  /** Enough of an element for the Overlay, and readable back as what it shows. */
  function createNode(tag: string): FakeNode {
    const attributes: Record<string, string> = {};
    let text = "";
    const node: FakeNode = {
      tagName: tag.toUpperCase(),
      className: "",
      hidden: false,
      lang: "",
      style: { setProperty: () => undefined } as Record<string, unknown>,
      dataset: {},
      attributes,
      classList: { toggle: () => undefined },
      setAttribute: (name: string, value: string) => {
        attributes[name] = value;
      },
      append: () => undefined,
      attachShadow: () => ({ append: () => undefined }),
      remove: () => undefined,
      get textContent() {
        return text;
      },
      set textContent(value: string) {
        text = value;
        if (node.className === "translation") {
          painted.push(value);
        }
      }
    };
    nodes.push(node);
    return node;
  }

  /** The translation line the overlay is showing, or null when it is hidden. */
  function caption(): string | null {
    const host = nodes.find(
      (node) => "data-tranlithion-overlay" in (node.attributes as Record<string, string>)
    );
    const style = host?.style as Record<string, unknown> | undefined;
    if (style?.display !== "block") {
      return null;
    }
    return nodes.find((node) => node.className === "translation")?.textContent ?? null;
  }

  const cueListeners = new Set<() => void>();
  const track = {
    kind: "subtitles",
    language: "ja",
    label: "日本語",
    mode: "disabled",
    cues: LINES,
    get activeCues() {
      return LINES.filter(
        (line) => line.startTime * 1_000 <= mediaTimeMs && mediaTimeMs < line.endTime * 1_000
      );
    },
    addEventListener: (_type: string, listener: () => void) => cueListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => cueListeners.delete(listener)
  };
  const video = {
    get currentTime() {
      return mediaTimeMs / 1_000;
    },
    playbackRate: 1,
    textTracks: Object.assign([track], {
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 450, width: 800, height: 450 })
  };

  vi.stubGlobal("location", { hostname: "video.example", pathname: "/watch" });
  vi.stubGlobal("performance", { now: () => wallClockMs });
  vi.stubGlobal("window", {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: (handler: () => void, ms?: number) => globalThis.setTimeout(handler, ms),
    clearTimeout: (handle: number) => globalThis.clearTimeout(handle),
    setInterval: (handler: () => void, ms?: number) => globalThis.setInterval(handler, ms),
    clearInterval: (handle: number) => globalThis.clearInterval(handle)
  });
  vi.stubGlobal("document", {
    fullscreenElement: null,
    body: { append: () => undefined },
    createElement: createNode,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("chrome", {
    runtime: {
      id: "tranlithion-test",
      sendMessage: async (message: SentMessage) => {
        messages.push(message);
        return { ok: true };
      }
    }
  });

  const settings: PublicTranslationSettings = {
    ...publicSettings(DEFAULT_SETTINGS),
    apiKeyConfigured: true,
    ...overrides
  };
  const controller = new SubtitleController(
    { kind: "video", video: video as unknown as HTMLVideoElement },
    settings,
    (cue: SubtitleCue): Promise<TranslationResponse> => {
      asked.push(cue);
      const ready = options.alreadyTranslated?.[cue.text];
      if (ready) {
        return Promise.resolve(answerFor(ready));
      }
      return new Promise((resolve) => {
        held.set(cue.text, resolve);
      });
    },
    () => undefined
  );
  controller.start();

  const cueFor = (text: string) => asked.find((cue) => cue.text === text);

  return {
    controller,
    painted,
    caption,
    asked,
    /** The lines each prefetch request asked for, in order. */
    prefetched: () =>
      messages
        .filter((message) => message.type === "PREFETCH_CUES")
        .map((message) => message.cues as SubtitleCue[]),
    warmUps: () => messages.filter((message) => message.type === "WARM_UP_TRANSLATOR"),
    /** One more piece of the model's answer for `text`, as the stream delivers it. */
    stream(text: string, partial: string) {
      controller.showPartialTranslation(controller.sessionId, cueFor(text)?.id ?? "", partial);
    },
    async answer(text: string, translation: string) {
      held.get(text)?.(answerFor(translation));
      held.delete(text);
      await vi.advanceTimersByTimeAsync(0);
    },
    async wait(ms: number) {
      wallClockMs += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
    /** Playback reaches `ms`, and the track reports the change. */
    async playTo(ms: number) {
      mediaTimeMs = ms;
      for (const listener of [...cueListeners]) {
        listener();
      }
      await vi.advanceTimersByTimeAsync(0);
    }
  };
}

describe("reading a film's captions in time", () => {
  let fixture: ReturnType<typeof createFixture> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    fixture?.controller.destroy();
    fixture = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fills the line in as the model streams it, not only its first words", async () => {
    fixture = createFixture({ draftCaptions: false });
    await fixture.wait(0);

    fixture.stream("おはよう", "早上");
    expect(fixture.caption()).toBe("早上");

    await fixture.wait(50);
    fixture.stream("おはよう", "早上好，");
    expect(fixture.caption()).toBe("早上好，");

    await fixture.answer("おはよう", "早上好，天气真好。");
    expect(fixture.caption()).toBe("早上好，天气真好。");

    // A chunk that arrives after the finished answer changes nothing.
    fixture.stream("おはよう", "早上好，天");
    expect(fixture.caption()).toBe("早上好，天气真好。");
  });

  it("skips a stream chunk too small and too soon to be worth a repaint", async () => {
    fixture = createFixture({ draftCaptions: false });
    await fixture.wait(0);

    fixture.stream("おはよう", "早上");
    fixture.stream("おはよう", "早上好");

    expect(fixture.caption()).toBe("早上");
  });

  it("keeps a draft on screen rather than shortening it with the model's first tokens", async () => {
    class TranslatorStub {
      static availability = vi.fn().mockResolvedValue("available");
      static create = vi.fn().mockResolvedValue({ translate: async () => "早上好（草稿）" });
    }
    vi.stubGlobal("Translator", TranslatorStub);
    fixture = createFixture({ draftCaptions: true, draftProvider: "browser" });
    await fixture.wait(0);
    expect(fixture.caption()).toBe("早上好（草稿）");

    fixture.stream("おはよう", "早上");
    expect(fixture.caption()).toBe("早上好（草稿）");

    await fixture.answer("おはよう", "早上好。");
    expect(fixture.caption()).toBe("早上好。");
  });

  it("puts an already translated line up without flashing a placeholder first", async () => {
    fixture = createFixture(
      { draftCaptions: false },
      { alreadyTranslated: { おはよう: "早上好。" } }
    );
    await fixture.wait(500);

    expect(fixture.caption()).toBe("早上好。");
    expect(fixture.painted).not.toContain(PLACEHOLDER);
  });

  it("says it is translating once the wait is long enough to notice", async () => {
    fixture = createFixture({ draftCaptions: false });

    await fixture.wait(140);
    expect(fixture.caption()).toBeNull();

    await fixture.wait(20);
    expect(fixture.caption()).toBe(PLACEHOLDER);
  });

  it("asks for the track's next lines before they are due", async () => {
    fixture = createFixture({ draftCaptions: false });
    await fixture.wait(0);

    // Once when the track turns up, and again with the first line on screen
    // leading the list.
    expect(fixture.prefetched().map((cues) => cues.map((cue) => cue.text))).toEqual([
      ["いい天気ですね", "散歩しましょう", "そうしましょう"],
      ["おはよう", "いい天気ですね", "散歩しましょう", "そうしましょう"]
    ]);
    const ahead = fixture.prefetched().at(-1)?.[1];

    await fixture.playTo(4_500);

    // The line that came on screen is the very cue that was prefetched, so
    // the background finds its translation already waiting.
    expect(fixture.asked.at(-1)?.id).toBe(ahead?.id);
    expect(fixture.prefetched().at(-1)?.map((cue) => cue.text)).toEqual([
      "いい天気ですね",
      "散歩しましょう",
      "そうしましょう",
      "行きましょう"
    ]);
  });

  it("opens the model's connection once, when captions appear", async () => {
    fixture = createFixture({ draftCaptions: false });
    await fixture.playTo(4_500);
    await fixture.playTo(7_500);

    expect(fixture.warmUps()).toEqual([
      { type: "WARM_UP_TRANSLATOR", model: true, draft: false }
    ]);
  });
});
