import { describe, expect, it } from "vitest";
import { isStickySource, reviseDebounceMs } from "../src/content/subtitle-controller";
import {
  isMeetingHost,
  isMeetingModeActive,
  keepsSpokenRecord,
  speakerEntityHints,
  MEETING_HOST_PERMISSIONS,
  meetingTextDestination
} from "../src/shared/meeting";
import {
  appendTranscriptLine,
  describeTranscriptSummary,
  expiredTranscriptKeys,
  isTranscriptSessionKey,
  MEETING_TRANSCRIPT_FAILURE_KEY,
  MEETING_TRANSCRIPT_SWEEP_INTERVAL_MS,
  retainedTranscriptFailures,
  summarizeTranscripts,
  transcriptPruneDue,
  MAX_TRANSCRIPT_LINES,
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
  it("keeps the selection buttons out of meetings unless the user asks for them", () => {
    expect(DEFAULT_SETTINGS.meetingSelectionToolbar).toBe(false);
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
      meetingSelectionToolbar: true,
      meetingOverlayHidden: true,
      meetingTranscript: false,
      meetingTranscriptRetentionDays: 30
    });

    expect(settings).toMatchObject({
      meetingMode: false,
      meetingFinalChannel: "local-mt",
      meetingSelectionToolbar: true,
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
    // Nor a subdomain: the granted origin is that one host, so a page under
    // any other name is a page meeting mode was never authorized to read.
    expect(isMeetingHost("evil.meet.google.com")).toBe(false);
  });

  it("keeps no record of what was said when the user declined one", () => {
    // The answer holds on every channel, including the chat model, whose own
    // context would otherwise write the last spoken lines and the names that
    // said them into extension storage.
    expect(keepsSpokenRecord({ meetingTranscript: false }, "meet-dom")).toBe(false);
    expect(keepsSpokenRecord({ meetingTranscript: true }, "meet-dom")).toBe(true);
    // A film's captions are not a record of a call and are unaffected.
    expect(keepsSpokenRecord({ meetingTranscript: false }, "netflix-dom")).toBe(true);
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

  it("does not call a LibreTranslate on another machine local", () => {
    // The same setting takes a LAN box or a VPS. Printing its address while
    // promising the text stays here would be a promise the address denies.
    const lan = meetingTextDestination({
      ...DEFAULT_SETTINGS,
      meetingFinalChannel: "local-mt",
      localMtUrl: "http://192.168.1.50:5000/translate"
    });
    const remote = meetingTextDestination({
      ...DEFAULT_SETTINGS,
      meetingFinalChannel: "local-mt",
      localMtUrl: "https://libre.example.com/translate"
    });

    expect(lan).toContain("192.168.1.50:5000");
    expect(lan).not.toContain("不离开这台电脑");
    expect(remote).toContain("libre.example.com");
    expect(remote).not.toContain("不离开这台电脑");
  });

  it("keeps the local claim for every way of writing the loopback address", () => {
    for (const url of [
      "http://localhost:5000/translate",
      "http://127.0.0.1:5000/translate",
      "http://[::1]:5000/translate"
    ]) {
      expect(
        meetingTextDestination({
          ...DEFAULT_SETTINGS,
          meetingFinalChannel: "local-mt",
          localMtUrl: url
        })
      ).toContain("不离开这台电脑");
    }
  });

  it("names the model endpoint when the chat model is the translator", () => {
    const copy = meetingTextDestination({
      ...DEFAULT_SETTINGS,
      meetingFinalChannel: "llm",
      draftCaptions: false,
      provider: "openai-compatible",
      apiBaseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash"
    });

    expect(copy).toContain("api.deepseek.com");
    expect(copy).toContain("deepseek-v4-flash");
  });

  it("names the draft service too, which the chat model channel also sends to", () => {
    // On this channel the draft runs beside the model, so the same sentence
    // reaches two services. A user who picked 大模型主译 to keep the meeting
    // with one provider has to be told about the second.
    const copy = meetingTextDestination({
      ...DEFAULT_SETTINGS,
      meetingFinalChannel: "llm",
      draftCaptions: true,
      draftProvider: "deepl",
      provider: "openai-compatible",
      apiBaseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash"
    });

    expect(copy).toContain("api.deepseek.com");
    expect(copy).toContain("DeepL");
    expect(copy).toContain("api-free.deepl.com");
  });

  it("names only the model when the draft stays on this machine or is off", () => {
    const onDevice = meetingTextDestination({
      ...DEFAULT_SETTINGS,
      meetingFinalChannel: "llm",
      draftCaptions: true,
      draftProvider: "browser"
    });
    const noDraft = meetingTextDestination({
      ...DEFAULT_SETTINGS,
      meetingFinalChannel: "llm",
      draftCaptions: false,
      draftProvider: "deepl"
    });

    expect(onDevice).not.toContain("api-free.deepl.com");
    expect(noDraft).not.toContain("api-free.deepl.com");
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

describe("speaker names the call registers", () => {
  it("leaves a speaker the user already gave a rendering for", () => {
    // 「@Alice Chen = 陈爱丽」 in the settings glossary: registering the name
    // as itself as well would hand the model two renderings for one person.
    expect(
      speakerEntityHints("Alice Chen", [
        { source: "Alice Chen", target: "陈爱丽", kind: "name" }
      ])
    ).toEqual([]);
    expect(
      speakerEntityHints("Alice Chen", [
        { source: " alice chen ", target: "陈爱丽", kind: "name" }
      ])
    ).toEqual([]);
  });

  it("registers a speaker the user never listed so the name stays stable", () => {
    expect(
      speakerEntityHints("Bob Tan", [{ source: "Alice Chen", target: "陈爱丽", kind: "name" }])
    ).toEqual([{ source: "Bob Tan", target: "Bob Tan", kind: "name" }]);
    expect(speakerEntityHints(undefined, [])).toEqual([]);
  });
});

describe("local meeting transcript", () => {
  it("records a bilingual line with its speaker", () => {
    const meeting = appendTranscriptLine(null, lineInput());

    expect(meeting?.lines).toEqual([
      {
        atMs: 1_000,
        speaker: "Alice Chen",
        source: "Good morning.",
        translation: "早上好。"
      }
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

  it("records a repeated sentence twice rather than folding it into one line", () => {
    // People repeat themselves, and "Okay." said twice was said twice. Only
    // the caller knows whether two lines are two cues, so the store never
    // second-guesses that from the wording.
    const once = appendTranscriptLine(null, lineInput({ source: "Okay.", translation: "好的。" }));
    const twice = appendTranscriptLine(
      once,
      lineInput({ source: "Okay.", translation: "好的。", atMs: 1_400 })
    );

    expect(twice?.lines.map((line) => line.source)).toEqual(["Okay.", "Okay."]);
  });

  it("keeps a line already written when a later one corrects its wording", () => {
    // The recognizer rewrites sentences it has already shown. What reached the
    // record was heard; the correction lands beside it, and nothing stored is
    // deleted or rewritten after the fact.
    const heard = appendTranscriptLine(null, lineInput({ source: "Hi everyone." }));
    const corrected = appendTranscriptLine(
      heard,
      lineInput({ source: "Hey everyone.", atMs: 1_400 })
    );

    expect(corrected?.lines.map((line) => line.source)).toEqual([
      "Hi everyone.",
      "Hey everyone."
    ]);
  });

  it("records the same words again when a different person says them", () => {
    const meeting = appendTranscriptLine(
      appendTranscriptLine(null, lineInput()),
      lineInput({ speaker: "Bob Tan", atMs: 1_400 })
    );

    expect(meeting?.lines).toHaveLength(2);
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

describe("how often the retention sweep reads the whole store", () => {
  it("sweeps once an hour rather than on every worker wake", () => {
    const now = 100 * DAY_MS;

    // An MV3 worker wakes for every popup and message; re-reading every
    // stored meeting each time buys nothing, while an hour between sweeps
    // keeps a record at most that long past the promised window.
    expect(transcriptPruneDue(now - 60_000, now)).toBe(false);
    expect(transcriptPruneDue(now - MEETING_TRANSCRIPT_SWEEP_INTERVAL_MS, now)).toBe(true);
  });

  it("sweeps when it has never swept, or when the clock moved backwards", () => {
    const now = 100 * DAY_MS;

    expect(transcriptPruneDue(undefined, now)).toBe(true);
    expect(transcriptPruneDue("yesterday", now)).toBe(true);
    expect(transcriptPruneDue(now + DAY_MS, now)).toBe(true);
  });
});

describe("telling the user a meeting stopped being recorded", () => {
  const NOW = 100 * DAY_MS;

  function storedWith(
    sessions: MeetingTranscriptSession[],
    failures: Record<string, { reason: string; atMs: number }>
  ): Record<string, unknown> {
    return {
      ...Object.fromEntries(
        sessions.map((one) => [transcriptSessionKey(one.sessionId), one])
      ),
      ...(Object.keys(failures).length > 0
        ? { [MEETING_TRANSCRIPT_FAILURE_KEY]: failures }
        : {})
    };
  }

  it("says nothing about failures when every write landed", () => {
    const summary = summarizeTranscripts({
      stored: storedWith([session("meeting-1", NOW - DAY_MS)], {}),
      nowMs: NOW,
      retentionDays: 7
    });

    expect(summary.stopped).toBeNull();
    expect(describeTranscriptSummary(summary)).toMatchObject({ state: "success" });
  });

  it("says every way a stored meeting can disappear, not just the retention window", () => {
    // The caps evict inside the window: a user with a few meetings a day
    // loses a three-day-old record while the page promises seven days.
    const described = describeTranscriptSummary(
      summarizeTranscripts({
        stored: storedWith([session("meeting-1", NOW - DAY_MS)], {}),
        nowMs: NOW,
        retentionDays: 7
      })
    );

    expect(described.text).toContain("7 天");
    expect(described.text).toContain(`${MAX_TRANSCRIPT_SESSIONS} 场会议`);
    expect(described.text).toContain(`${MAX_TRANSCRIPT_LINES} 行`);
  });

  it("keeps a refused write visible in the settings page, with the newest reason", () => {
    // The live status line is overwritten by the next caption a second
    // later; this is where the user can still find out afterwards.
    const summary = summarizeTranscripts({
      stored: storedWith([session("meeting-1", NOW - DAY_MS)], {
        "meeting-1": { reason: "存储空间可能已满", atMs: NOW - 2 * DAY_MS },
        "meeting-2": { reason: "QUOTA_BYTES quota exceeded", atMs: NOW - DAY_MS }
      }),
      nowMs: NOW,
      retentionDays: 7
    });

    expect(summary.stopped).toEqual({ meetings: 2, reason: "QUOTA_BYTES quota exceeded" });

    const described = describeTranscriptSummary(summary);
    expect(described.state).toBe("error");
    expect(described.text).toContain("2 场会议中途写入失败");
    expect(described.text).toContain("QUOTA_BYTES quota exceeded");
    expect(described.text).toContain("没有再被记录");
  });

  it("keeps the note as long as the truncated record it describes", () => {
    // What `chrome.storage.local` holds after the write was refused, read
    // back the way the worker reads it on a later launch.
    const summary = summarizeTranscripts({
      stored: storedWith([session("meeting-1", NOW - 2 * DAY_MS)], {
        "meeting-1": { reason: "存储空间可能已满", atMs: NOW - 2 * DAY_MS }
      }),
      nowMs: NOW,
      retentionDays: 7
    });

    expect(summary.sessions).toBe(1);
    expect(summary.stopped).toEqual({ meetings: 1, reason: "存储空间可能已满" });
  });

  it("drops the note at the same moment the record it describes expires", () => {
    const spoken = NOW - 8 * DAY_MS;
    const stored = storedWith([session("meeting-1", spoken)], {
      "meeting-1": { reason: "存储空间可能已满", atMs: spoken }
    });

    // The record is past the window, so the summary counts neither it nor
    // the note about it: a note never outlives what it describes.
    expect(expiredTranscriptKeys(readTranscriptSessions(stored), NOW, 7)).toEqual([
      transcriptSessionKey("meeting-1")
    ]);
    expect(summarizeTranscripts({ stored, nowMs: NOW, retentionDays: 7 })).toMatchObject({
      sessions: 0,
      stopped: null
    });
  });

  it("drops the note as soon as a shorter retention window is chosen", () => {
    // Switching 保留时长 to one day expires both halves at once, with no
    // worker restart in between.
    const stored = storedWith([session("meeting-1", NOW - 3 * DAY_MS)], {
      "meeting-1": { reason: "存储空间可能已满", atMs: NOW - 3 * DAY_MS }
    });

    expect(summarizeTranscripts({ stored, nowMs: NOW, retentionDays: 7 }).stopped).not.toBeNull();
    expect(summarizeTranscripts({ stored, nowMs: NOW, retentionDays: 1 })).toMatchObject({
      sessions: 0,
      stopped: null
    });
  });

  it("reports the stopped meeting even when nothing was ever stored", () => {
    // The very first write of the call was refused, so there is no session to
    // count — and that is exactly the case the user must still hear about.
    const described = describeTranscriptSummary(
      summarizeTranscripts({
        stored: storedWith([], {
          "meeting-1": { reason: "存储空间可能已满", atMs: NOW - DAY_MS }
        }),
        nowMs: NOW,
        retentionDays: 7
      })
    );

    expect(described.state).toBe("error");
    expect(described.text).toContain("没有保存任何会议记录");
    expect(described.text).toContain("1 场会议中途写入失败");
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
