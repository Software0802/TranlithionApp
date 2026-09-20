import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptLine,
  MEETING_TRANSCRIPT_SWEEP_INTERVAL_MS,
  transcriptSessionKey
} from "../src/shared/meeting-transcript";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from "../src/shared/settings";

/**
 * The background worker's retention sweep, driven through the extension APIs
 * it actually uses: a fake `chrome.storage` and the wake-up and message
 * listeners the worker registers on import.
 *
 * D7 promises a window, so what matters here is when records really leave the
 * store — not how often the worker feels like looking.
 */

const DAY_MS = 86_400_000;
const START_MS = 100 * DAY_MS;

function transcriptOf(sessionId: string, updatedAtMs: number) {
  return appendTranscriptLine(null, {
    sessionId,
    host: "meet.google.com",
    title: "Weekly sync",
    atMs: updatedAtMs,
    speaker: "Alice Chen",
    source: "Good morning.",
    translation: "[zh] Good morning."
  });
}

async function startWorker(seed: Record<string, unknown>) {
  let nowMs = START_MS;
  const local: Record<string, unknown> = { ...seed };
  const session: Record<string, unknown> = {};
  const wakeListeners: (() => void)[] = [];
  let receive:
    | ((message: unknown, sender: unknown, respond: (value: unknown) => void) => boolean)
    | null = null;

  function area(store: Record<string, unknown>) {
    return {
      async get(keys?: string | string[] | null) {
        if (keys === undefined || keys === null) {
          return { ...store };
        }
        const names = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(
          names.filter((name) => name in store).map((name) => [name, store[name]])
        );
      },
      async set(values: Record<string, unknown>) {
        Object.assign(store, values);
      },
      async remove(keys: string | string[]) {
        for (const name of Array.isArray(keys) ? keys : [keys]) {
          delete store[name];
        }
      },
      async setAccessLevel() {
        return undefined;
      }
    };
  }

  vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  vi.stubGlobal("chrome", {
    runtime: {
      id: "tranlithion-test",
      onInstalled: { addListener: () => undefined },
      onStartup: { addListener: (listener: () => void) => wakeListeners.push(listener) },
      onMessage: {
        addListener: (listener: typeof receive) => {
          receive = listener;
        }
      }
    },
    storage: {
      local: area(local),
      session: area(session),
      onChanged: { addListener: () => undefined }
    },
    tabs: {
      onRemoved: { addListener: () => undefined },
      query: async () => [],
      sendMessage: async () => undefined
    }
  });

  vi.resetModules();
  await import("../src/background/index");
  await settle();

  return {
    /** The meetings still on disk, by session id. */
    storedSessions: () =>
      Object.keys(local)
        .filter((key) => key.startsWith("meeting-transcript:"))
        .sort(),
    write(key: string, value: unknown) {
      local[key] = value;
    },
    advance(ms: number) {
      nowMs += ms;
    },
    /** The MV3 worker starting up again — a popup, a message, a browser start. */
    async wake() {
      for (const listener of wakeListeners) {
        listener();
      }
      await settle();
    },
    async send(message: unknown) {
      await new Promise((resolve) => {
        receive?.(message, {}, resolve);
      });
      await settle();
    }
  };
}

/** Lets the worker's queued storage folds finish. */
async function settle(): Promise<void> {
  for (let step = 0; step < 6; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("the meeting transcript retention sweep", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("deletes expired meetings on waking, then leaves the store alone for an hour", async () => {
    const worker = await startWorker({
      [SETTINGS_STORAGE_KEY]: { ...DEFAULT_SETTINGS, meetingTranscript: true },
      [transcriptSessionKey("old")]: transcriptOf("old", START_MS - 8 * DAY_MS),
      [transcriptSessionKey("today")]: transcriptOf("today", START_MS - 60_000)
    });

    expect(worker.storedSessions()).toEqual([transcriptSessionKey("today")]);

    // An MV3 worker wakes for every popup and message. Re-reading every
    // stored meeting each time buys nothing this soon after the last sweep.
    worker.write(transcriptSessionKey("stale"), transcriptOf("stale", START_MS - 9 * DAY_MS));
    worker.advance(MEETING_TRANSCRIPT_SWEEP_INTERVAL_MS - 60_000);
    await worker.wake();

    expect(worker.storedSessions()).toContain(transcriptSessionKey("stale"));

    worker.advance(120_000);
    await worker.wake();

    expect(worker.storedSessions()).toEqual([transcriptSessionKey("today")]);
  });

  it("applies a shortened retention window at the next wake", async () => {
    const worker = await startWorker({
      [SETTINGS_STORAGE_KEY]: {
        ...DEFAULT_SETTINGS,
        meetingTranscript: true,
        meetingTranscriptRetentionDays: 30
      },
      [transcriptSessionKey("last-week")]: transcriptOf("last-week", START_MS - 8 * DAY_MS)
    });

    expect(worker.storedSessions()).toEqual([transcriptSessionKey("last-week")]);

    // Retention is a privacy control: the records the user just asked to drop
    // go on the next wake, not after the sweep's interval.
    await worker.send({ type: "SAVE_SETTINGS", patch: { meetingTranscriptRetentionDays: 7 } });
    await worker.wake();

    expect(worker.storedSessions()).toEqual([]);
  });

  it("sweeps again at the next wake after the records were cleared", async () => {
    const worker = await startWorker({
      [SETTINGS_STORAGE_KEY]: { ...DEFAULT_SETTINGS, meetingTranscript: true },
      [transcriptSessionKey("today")]: transcriptOf("today", START_MS - 60_000)
    });

    await worker.send({ type: "CLEAR_MEETING_TRANSCRIPTS" });

    expect(worker.storedSessions()).toEqual([]);

    worker.write(transcriptSessionKey("stale"), transcriptOf("stale", START_MS - 9 * DAY_MS));
    await worker.wake();

    expect(worker.storedSessions()).toEqual([]);
  });
});
