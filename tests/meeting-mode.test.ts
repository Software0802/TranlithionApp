import { describe, expect, it } from "vitest";
import { isStickySource, reviseDebounceMs } from "../src/content/subtitle-controller";
import {
  isMeetingHost,
  isMeetingModeActive,
  MEETING_HOST_PERMISSIONS,
  meetingTextDestination
} from "../src/shared/meeting";
import {
  appendTranscriptLine,
  listTranscriptSessions,
  MAX_TRANSCRIPT_SESSIONS,
  pruneTranscripts,
  readTranscriptStore,
  type MeetingTranscriptStore
} from "../src/shared/meeting-transcript";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/shared/settings";

const DAY_MS = 86_400_000;

function lineInput(overrides: Partial<Parameters<typeof appendTranscriptLine>[1]> = {}) {
  return {
    sessionId: "meeting-1",
    host: "meet.google.com",
    title: "Weekly sync",
    atMs: 1_000,
    speaker: "Alice Chen",
    source: "Good morning.",
    translation: "早上好。",
    ...overrides
  };
}

describe("meeting mode defaults", () => {
  it("keeps the mascot out of meetings unless the user asks for it", () => {
    expect(DEFAULT_SETTINGS.meetingMascot).toBe(false);
  });

  it("defaults the meeting caption to the cheap machine-translation channel", () => {
    // An hour of meeting is several times an episode's line count, so the
    // chat model is opt-in rather than the default translator.
    expect(DEFAULT_SETTINGS.meetingFinalChannel).toBe("fast-mt");
  });

  it("stores a meeting transcript locally and expires it after a week", () => {
    expect(DEFAULT_SETTINGS.meetingTranscript).toBe(true);
    expect(DEFAULT_SETTINGS.meetingTranscriptRetentionDays).toBe(7);
  });

  it("starts with the overlay visible", () => {
    expect(DEFAULT_SETTINGS.meetingOverlayHidden).toBe(false);
    expect(DEFAULT_SETTINGS.meetingMode).toBe(true);
  });

  it("rejects an unknown channel and clamps an out-of-range retention window", () => {
    const settings = normalizeSettings({
      meetingFinalChannel: "quantum",
      meetingTranscriptRetentionDays: 9_000
    });

    expect(settings.meetingFinalChannel).toBe("fast-mt");
    expect(settings.meetingTranscriptRetentionDays).toBe(90);
    expect(normalizeSettings({ meetingTranscriptRetentionDays: 0 })
      .meetingTranscriptRetentionDays).toBe(1);
  });

  it("keeps a user's choices through normalization", () => {
    const settings = normalizeSettings({
      meetingMode: false,
      meetingFinalChannel: "local-mt",
      meetingMascot: true,
      meetingOverlayHidden: true,
      meetingTranscript: false,
      meetingTranscriptRetentionDays: 30
    });

    expect(settings).toMatchObject({
      meetingMode: false,
      meetingFinalChannel: "local-mt",
      meetingMascot: true,
      meetingOverlayHidden: true,
      meetingTranscript: false,
      meetingTranscriptRetentionDays: 30
    });
  });
});

describe("meeting host detection", () => {
  it("recognizes Google Meet and nothing else", () => {
    expect(isMeetingHost("meet.google.com")).toBe(true);
    expect(isMeetingHost("MEET.GOOGLE.COM")).toBe(true);
    expect(isMeetingHost("www.youtube.com")).toBe(false);
    expect(isMeetingHost("zoom.us")).toBe(false);
    // A lookalike domain must not switch meeting behaviour on.
    expect(isMeetingHost("meet.google.com.evil.example")).toBe(false);
  });

  it("requires both the user's switch and an actual meeting host", () => {
    expect(isMeetingModeActive({ meetingMode: true }, "meet.google.com")).toBe(true);
    expect(isMeetingModeActive({ meetingMode: false }, "meet.google.com")).toBe(false);
    expect(isMeetingModeActive({ meetingMode: true }, "www.netflix.com")).toBe(false);
  });

  it("asks for the meeting origin as an optional permission only", () => {
    expect([...MEETING_HOST_PERMISSIONS]).toEqual(["https://meet.google.com/*"]);
  });
});

describe("meeting text destination disclosure", () => {
  it("names the machine-translation service that receives meeting text", () => {
    const copy = meetingTextDestination({
      ...DEFAULT_SETTINGS,
      meetingFinalChannel: "fast-mt",
      draftProvider: "deepl"
    });

    expect(copy).toContain("DeepL");
    expect(copy).toContain("api-free.deepl.com");
  });

  it("says plainly when nothing leaves the machine", () => {
    const local = meetingTextDestination({
      ...DEFAULT_SETTINGS,
      meetingFinalChannel: "local-mt"
    });
    const onDevice = meetingTextDestination({
      ...DEFAULT_SETTINGS,
      meetingFinalChannel: "fast-mt",
      draftProvider: "browser"
    });

    expect(local).toContain("127.0.0.1:5000");
    expect(local).toContain("不离开这台电脑");
    expect(onDevice).toContain("不离开这台电脑");
  });

  it("names the model endpoint when the chat model is the translator", () => {
    const copy = meetingTextDestination({
      ...DEFAULT_SETTINGS,
      meetingFinalChannel: "llm",
      provider: "openai-compatible",
      apiBaseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash"
    });

    expect(copy).toContain("api.deepseek.com");
    expect(copy).toContain("deepseek-v4-flash");
  });
});

describe("meeting caption timing rules", () => {
  it("waits longer for a recognizer line to settle than for a player repaint", () => {
    // Speech recognition rewrites a line several times a second; debouncing
    // like Netflix would spend one request per partial.
    expect(reviseDebounceMs("meet-dom")).toBeGreaterThan(reviseDebounceMs("netflix-dom"));
  });

  it("treats meeting captions as a sticky source so the overlay never blanks", () => {
    expect(isStickySource("meet-dom")).toBe(true);
    expect(isStickySource("netflix-dom")).toBe(true);
    expect(isStickySource("text-track")).toBe(false);
    expect(isStickySource("youtube-dom")).toBe(false);
  });
});

describe("local meeting transcript", () => {
  it("records a bilingual line with its speaker", () => {
    const store = appendTranscriptLine({}, lineInput());

    expect(store["meeting-1"].lines).toEqual([
      { atMs: 1_000, speaker: "Alice Chen", source: "Good morning.", translation: "早上好。" }
    ]);
    expect(store["meeting-1"].title).toBe("Weekly sync");
  });

  it("does not record the same line twice when a revision settles unchanged", () => {
    const once = appendTranscriptLine({}, lineInput());
    const twice = appendTranscriptLine(once, lineInput({ atMs: 1_400 }));

    expect(twice["meeting-1"].lines).toHaveLength(1);
  });

  it("records the same words again when a different person says them", () => {
    const store = appendTranscriptLine(
      appendTranscriptLine({}, lineInput()),
      lineInput({ speaker: "Bob Tan", atMs: 1_400 })
    );

    expect(store["meeting-1"].lines).toHaveLength(2);
  });

  it("ignores a line with nothing on one side of it", () => {
    expect(appendTranscriptLine({}, lineInput({ translation: "   " }))).toEqual({});
    expect(appendTranscriptLine({}, lineInput({ source: "" }))).toEqual({});
  });

  it("deletes meetings older than the retention window", () => {
    const now = 100 * DAY_MS;
    const store: MeetingTranscriptStore = {
      fresh: session("fresh", now - 2 * DAY_MS),
      stale: session("stale", now - 8 * DAY_MS)
    };

    const pruned = pruneTranscripts(store, now, 7);

    expect(Object.keys(pruned)).toEqual(["fresh"]);
  });

  it("keeps a meeting that is exactly inside the window", () => {
    const now = 100 * DAY_MS;
    const pruned = pruneTranscripts({ edge: session("edge", now - 7 * DAY_MS) }, now, 7);

    expect(Object.keys(pruned)).toEqual(["edge"]);
  });

  it("caps how many meetings are kept, newest first", () => {
    let store: MeetingTranscriptStore = {};
    for (let index = 0; index < MAX_TRANSCRIPT_SESSIONS + 5; index += 1) {
      store = appendTranscriptLine(store, lineInput({
        sessionId: `meeting-${index}`,
        atMs: 1_000 + index
      }));
    }

    const sessions = listTranscriptSessions(store);
    expect(sessions).toHaveLength(MAX_TRANSCRIPT_SESSIONS);
    expect(sessions[0].sessionId).toBe(`meeting-${MAX_TRANSCRIPT_SESSIONS + 4}`);
  });

  it("drops anything in storage that is not a transcript", () => {
    expect(readTranscriptStore("not a store")).toEqual({});
    expect(readTranscriptStore({ broken: { sessionId: 7 } })).toEqual({});
    const valid = appendTranscriptLine({}, lineInput());
    expect(readTranscriptStore(valid)).toEqual(valid);
  });
});

function session(sessionId: string, updatedAtMs: number) {
  return {
    sessionId,
    host: "meet.google.com",
    title: "Weekly sync",
    startedAtMs: updatedAtMs - 1_000,
    updatedAtMs,
    lines: []
  };
}
