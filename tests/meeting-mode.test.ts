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
  expiredTranscriptKeys,
  isTranscriptSessionKey,
  MAX_TRANSCRIPT_SESSIONS,
  readTranscriptSession,
  readTranscriptSessions,
  retainedTranscriptSessions,
  transcriptSessionKey,
  type MeetingTranscriptSession
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

  it("reads no meeting and stores no transcript until the user opts in", () => {
    // A host permission granted for something else must never be enough to
    // start listening to a call or writing it to disk.
    expect(DEFAULT_SETTINGS.meetingMode).toBe(false);
    expect(DEFAULT_SETTINGS.meetingTranscript).toBe(false);
    expect(isMeetingModeActive(DEFAULT_SETTINGS, "meet.google.com")).toBe(false);
  });

  it("expires a transcript the user does switch on after a week", () => {
    expect(DEFAULT_SETTINGS.meetingTranscriptRetentionDays).toBe(7);
  });

  it("starts with the overlay visible", () => {
    expect(DEFAULT_SETTINGS.meetingOverlayHidden).toBe(false);
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
    const meeting = appendTranscriptLine(null, lineInput());

    expect(meeting?.lines).toEqual([
      { atMs: 1_000, speaker: "Alice Chen", source: "Good morning.", translation: "早上好。" }
    ]);
    expect(meeting?.title).toBe("Weekly sync");
  });

  it("keeps each meeting under its own storage key", () => {
    // One line lands every few seconds for the length of a meeting, so a line
    // may never cost a rewrite of every meeting ever recorded.
    expect(transcriptSessionKey("meeting-1")).not.toBe(transcriptSessionKey("meeting-2"));
    expect(isTranscriptSessionKey(transcriptSessionKey("meeting-1"))).toBe(true);
    expect(isTranscriptSessionKey("translation-settings")).toBe(false);
  });

  it("does not record the same line twice when a revision settles unchanged", () => {
    const once = appendTranscriptLine(null, lineInput());
    const twice = appendTranscriptLine(once, lineInput({ atMs: 1_400 }));

    expect(twice?.lines).toHaveLength(1);
    // Unchanged: the caller skips the storage write entirely.
    expect(twice).toBe(once);
  });

  it("records the same words again when a different person says them", () => {
    const meeting = appendTranscriptLine(
      appendTranscriptLine(null, lineInput()),
      lineInput({ speaker: "Bob Tan", atMs: 1_400 })
    );

    expect(meeting?.lines).toHaveLength(2);
  });

  it("replaces a line the recognizer took back rather than keeping both", () => {
    const withdrawn = appendTranscriptLine(null, lineInput({ source: "Hi everyone." }));
    const corrected = appendTranscriptLine(
      withdrawn,
      lineInput({ source: "Hey everyone.", atMs: 1_400, replaces: ["Hi everyone."] })
    );

    expect(corrected?.lines.map((line) => line.source)).toEqual(["Hey everyone."]);
  });

  it("leaves lines alone when the withdrawn wording is not the last one", () => {
    const first = appendTranscriptLine(null, lineInput({ source: "Good morning." }));
    const second = appendTranscriptLine(first, lineInput({ source: "Let's begin.", atMs: 1_400 }));
    const third = appendTranscriptLine(
      second,
      lineInput({ source: "Any questions?", atMs: 1_800, replaces: ["Good morning."] })
    );

    expect(third?.lines.map((line) => line.source)).toEqual([
      "Good morning.",
      "Let's begin.",
      "Any questions?"
    ]);
  });

  it("ignores a line with nothing on one side of it", () => {
    expect(appendTranscriptLine(null, lineInput({ translation: "   " }))).toBeNull();
    expect(appendTranscriptLine(null, lineInput({ source: "" }))).toBeNull();
  });

  it("deletes meetings older than the retention window", () => {
    const now = 100 * DAY_MS;
    const sessions = [session("fresh", now - 2 * DAY_MS), session("stale", now - 8 * DAY_MS)];

    expect(retainedTranscriptSessions(sessions, now, 7).map((one) => one.sessionId)).toEqual([
      "fresh"
    ]);
    expect(expiredTranscriptKeys(sessions, now, 7)).toEqual([transcriptSessionKey("stale")]);
  });

  it("keeps a meeting that is exactly inside the window", () => {
    const now = 100 * DAY_MS;
    const sessions = [session("edge", now - 7 * DAY_MS)];

    expect(retainedTranscriptSessions(sessions, now, 7).map((one) => one.sessionId)).toEqual([
      "edge"
    ]);
    expect(expiredTranscriptKeys(sessions, now, 7)).toEqual([]);
  });

  it("caps how many meetings are kept, newest first", () => {
    const now = 100 * DAY_MS;
    const sessions = Array.from({ length: MAX_TRANSCRIPT_SESSIONS + 5 }, (_, index) =>
      session(`meeting-${index}`, now - index * 1_000)
    );

    const retained = retainedTranscriptSessions(sessions, now, 7);

    expect(retained).toHaveLength(MAX_TRANSCRIPT_SESSIONS);
    expect(retained[0].sessionId).toBe("meeting-0");
    expect(expiredTranscriptKeys(sessions, now, 7)).toHaveLength(5);
  });

  it("reads meetings out of storage and ignores everything else in it", () => {
    const meeting = appendTranscriptLine(null, lineInput());

    expect(readTranscriptSession("not a meeting")).toBeNull();
    expect(readTranscriptSession({ sessionId: 7 })).toBeNull();
    expect(
      readTranscriptSessions({
        "translation-settings": { enabled: true },
        [transcriptSessionKey("meeting-1")]: meeting,
        [transcriptSessionKey("broken")]: { sessionId: 7 }
      })
    ).toEqual([meeting]);
  });
});

function session(sessionId: string, updatedAtMs: number): MeetingTranscriptSession {
  return {
    sessionId,
    host: "meet.google.com",
    title: "Weekly sync",
    startedAtMs: updatedAtMs - 1_000,
    updatedAtMs,
    lines: []
  };
}
