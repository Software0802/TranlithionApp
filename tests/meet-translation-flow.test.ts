import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEET_CAPTION_SETTLE_DELAY_MS,
  MEET_NATIVE_HIDE_STYLE_ID,
  MEET_REGION_POLL_INTERVAL_MS,
  MeetCaptionAdapter
} from "../src/content/adapters/meet-caption-adapter";
import type { SubtitleAdapterEvent } from "../src/content/adapters/types";
import { SubtitleController } from "../src/content/subtitle-controller";
import {
  appendTranscriptLine,
  type MeetingTranscriptSession
} from "../src/shared/meeting-transcript";
import { DEFAULT_SETTINGS, publicSettings } from "../src/shared/settings";
import type {
  PublicTranslationSettings,
  SubtitleCue,
  TranslationResponse
} from "../src/shared/types";
import { element, type FakeElement } from "./helpers/fake-dom";

/**
 * Drives the whole meeting path — Meet's caption DOM, the controller, the
 * single machine-translation channel and the D7 transcript — against fakes.
 *
 * What it guards is the seam between them. A recognizer punctuates
 * retroactively, so the sentence that just finished and the one replacing it
 * arrive in the same read: the finished one still has to be translated and
 * recorded, and the growing prefixes on the way to it must not be.
 */

const SETTLE_MS = MEET_CAPTION_SETTLE_DELAY_MS;
const TICK_MS = 200;
const REVISE_DEBOUNCE_MS = 400;

interface Turn {
  speaker: string;
  text: string;
}

interface RecordedLine {
  source: string;
  translation: string;
  speaker?: string;
}

interface FakeNode {
  id: string;
  remove: () => void;
  [key: string]: unknown;
}

function createFixture() {
  let wallClockMs = 0;
  let notifyMutation: (() => void) | null = null;

  const region = element({
    className: "a4cQT",
    attributes: { role: "region", "aria-label": "Captions" }
  });
  /** Stylesheets currently in the document head, by id. */
  const documentStyles = new Map<string, FakeNode>();

  const draftRequests: string[] = [];
  const modelRequests: string[] = [];
  const recorded: RecordedLine[] = [];
  /** Source lines the channel refuses to translate. */
  const draftFailures: string[] = [];
  /** Source lines whose answer is held until the test releases it. */
  const heldSources = new Set<string>();
  const heldAnswers = new Map<string, (response: unknown) => void>();

  /** Enough of an element for the Overlay; none of it is asserted on. */
  function createNode(tag: string): FakeNode {
    const node: FakeNode = {
      tagName: tag.toUpperCase(),
      id: "",
      className: "",
      textContent: "",
      hidden: false,
      lang: "",
      parentElement: null,
      style: { setProperty: () => undefined },
      dataset: {},
      classList: { toggle: () => undefined },
      setAttribute: () => undefined,
      append: () => undefined,
      attachShadow: () => ({ append: () => undefined }),
      remove: () => {
        documentStyles.delete(node.id);
      }
    };
    return node;
  }

  vi.stubGlobal("location", { hostname: "meet.google.com", pathname: "/abc-defg-hij" });
  vi.stubGlobal("performance", { now: () => wallClockMs });
  vi.stubGlobal("window", {
    innerWidth: 1_280,
    innerHeight: 720,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: (handler: () => void, ms?: number) => globalThis.setTimeout(handler, ms),
    clearTimeout: (handle: number) => globalThis.clearTimeout(handle),
    setInterval: (handler: () => void, ms?: number) => globalThis.setInterval(handler, ms),
    clearInterval: (handle: number) => globalThis.clearInterval(handle)
  });
  vi.stubGlobal("document", {
    title: "Weekly sync",
    fullscreenElement: null,
    body: { append: () => undefined },
    head: {
      append: (node: FakeNode) => {
        documentStyles.set(node.id, node);
      }
    },
    createElement: createNode,
    getElementById: (id: string) => documentStyles.get(id) ?? null,
    querySelectorAll: (selector: string) => (region.matches(selector) ? [region] : []),
    querySelector: (selector: string) => (region.matches(selector) ? region : null),
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
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        notifyMutation = callback;
      }
      observe() {}
      disconnect() {
        notifyMutation = null;
      }
    }
  );
  vi.stubGlobal("chrome", {
    runtime: {
      id: "tranlithion-test",
      sendMessage: async (message: { type: string; [key: string]: unknown }) => {
        if (message.type === "DRAFT_TRANSLATE") {
          const text = String(message.text);
          draftRequests.push(text);
          if (draftFailures.includes(text)) {
            return { ok: false };
          }
          if (heldSources.has(text)) {
            return new Promise((resolve) => {
              heldAnswers.set(text, resolve);
            });
          }
          return { ok: true, text: `[zh] ${text}` };
        }
        if (message.type === "RECORD_MEETING_LINE") {
          const cue = message.cue as SubtitleCue;
          recorded.push({
            source: cue.text,
            translation: String(message.translation),
            speaker: cue.speaker
          });
        }
        return undefined;
      }
    }
  });

  /** The controller's own handler for adapter events, and the ends it saw. */
  let deliver: ((event: SubtitleAdapterEvent) => void) | null = null;
  const cueEnds: SubtitleAdapterEvent[] = [];
  const startAdapter = MeetCaptionAdapter.prototype.start;
  vi.spyOn(MeetCaptionAdapter.prototype, "start").mockImplementation(function (
    this: MeetCaptionAdapter,
    onEvent: (event: SubtitleAdapterEvent) => void
  ) {
    deliver = onEvent;
    startAdapter.call(this, (event) => {
      if (event.type === "cue-end") {
        cueEnds.push(event);
      }
      onEvent(event);
    });
  });

  const settings: PublicTranslationSettings = {
    ...publicSettings(DEFAULT_SETTINGS),
    meetingMode: true,
    meetingTranscript: true,
    draftProvider: "deepl",
    draftApiKeyConfigured: true
  };
  const controller = new SubtitleController(
    { kind: "page" },
    settings,
    async (cue: SubtitleCue): Promise<TranslationResponse> => {
      modelRequests.push(cue.text);
      return {
        ok: true,
        translation: {
          text: `[llm] ${cue.text}`,
          provider: "mock",
          latencyMs: 1,
          entityHints: []
        }
      };
    },
    () => undefined
  );
  controller.start();

  /**
   * Meet keeps the node of a turn it is still growing and appends a node for a
   * new one, so rows are reused by position rather than re-rendered wholesale.
   */
  function rebuild(turns: Turn[]): void {
    region.children.length = Math.min(region.children.length, turns.length);
    turns.forEach((turn, index) => {
      const existing = region.children[index];
      if (existing) {
        existing.querySelector(".zs7s8d")?.setText(turn.speaker);
        existing.querySelector(".bh44bd")?.setText(turn.text);
        return;
      }
      region.children.push(
        element({
          className: "nMcdL",
          children: [
            { className: "zs7s8d", text: turn.speaker },
            { className: "bh44bd", attributes: { jsname: "tgaKEf" }, text: turn.text }
          ]
        }) as FakeElement
      );
    });
  }

  return {
    controller,
    draftRequests,
    modelRequests,
    recorded,
    draftFailures,
    /** Whether Meet's own caption strip is readable to the user right now. */
    nativeCaptionsVisible: () => !documentStyles.has(MEET_NATIVE_HIDE_STYLE_ID),
    /** The one-click 「隐藏译文（共享屏幕）」 switch. */
    setOverlayHidden(hidden: boolean) {
      controller.updateSettings({ ...settings, meetingOverlayHidden: hidden });
    },
    /** Holds this line's translation until `release`, as a slow channel would. */
    hold(source: string) {
      heldSources.add(source);
    },
    /** Hands the controller the cue-end it just saw a second time. */
    async redeliverLastCueEnd() {
      deliver?.(cueEnds[cueEnds.length - 1]);
      await vi.advanceTimersByTimeAsync(0);
    },
    async release(source: string) {
      heldSources.delete(source);
      heldAnswers.get(source)?.({ ok: true, text: `[zh] ${source}` });
      heldAnswers.delete(source);
      await vi.advanceTimersByTimeAsync(0);
    },
    async render(turns: Turn[]) {
      rebuild(turns);
      if (notifyMutation) {
        notifyMutation();
      } else {
        // The region is only adopted once it is carrying caption rows, so the
        // first strip is picked up by the discovery poll.
        await vi.advanceTimersByTimeAsync(MEET_REGION_POLL_INTERVAL_MS);
      }
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
    },
    /** Advances the wall clock while the adapter's heartbeat runs. */
    async wait(ms: number) {
      const steps = Math.ceil(ms / TICK_MS);
      for (let step = 0; step < steps; step += 1) {
        wallClockMs += Math.min(TICK_MS, ms - step * TICK_MS);
        await vi.advanceTimersByTimeAsync(TICK_MS);
      }
    }
  };
}

describe("meeting translation flow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("translates and records a sentence the next one replaces in the same read", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "Good morning" }]);

    await fixture.render([{ speaker: "Alice Chen", text: "Good morning. Let's" }]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    expect(fixture.draftRequests).toContain("Good morning.");
    expect(fixture.recorded).toMatchObject([
      { source: "Good morning.", translation: "[zh] Good morning.", speaker: "Alice Chen" }
    ]);
  });

  it("records only the settled line, not the prefixes it grew through", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "Good" }]);
    await fixture.wait(REVISE_DEBOUNCE_MS);
    await fixture.render([{ speaker: "Alice Chen", text: "Good morning" }]);
    await fixture.wait(REVISE_DEBOUNCE_MS);
    await fixture.render([{ speaker: "Alice Chen", text: "Good morning everyone." }]);
    await fixture.wait(REVISE_DEBOUNCE_MS);

    // The transcript is a record of what was said, not of every repaint on
    // the way there, so nothing is written until the sentence is over.
    expect(fixture.recorded).toEqual([]);

    await fixture.render([]);
    await fixture.wait(2_000);

    expect(fixture.recorded).toMatchObject([
      {
        source: "Good morning everyone.",
        translation: "[zh] Good morning everyone.",
        speaker: "Alice Chen"
      }
    ]);
  });

  it("spends no request on the opening fragment of a turn", async () => {
    const fixture = createFixture();

    await fixture.render([{ speaker: "Alice Chen", text: "So" }]);

    // The recognizer's first word or two is rewritten by the next read.
    // Translating it would cost a request per sentence for text nobody
    // finishes reading, on the channel chosen to keep a meeting cheap.
    expect(fixture.draftRequests).toEqual([]);

    await fixture.render([{ speaker: "Alice Chen", text: "So I think we should ship." }]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    expect(fixture.draftRequests).toEqual(["So I think we should ship."]);
  });

  it("never finishes a meeting line on the chat model when a fast channel is the final", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "Good morning. Let's" }]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    expect(fixture.modelRequests).toEqual([]);
  });

  it("brings Meet's own captions back when the only channel answers with nothing", async () => {
    const fixture = createFixture();
    fixture.draftFailures.push("Nothing comes back for this.");

    await fixture.render([{ speaker: "Alice Chen", text: "Nothing comes back for this." }]);
    await fixture.wait(REVISE_DEBOUNCE_MS);

    // There is no translation to read, so the line the user could have read
    // must not stay hidden behind our stylesheet.
    expect(fixture.nativeCaptionsVisible()).toBe(true);

    await fixture.render([{ speaker: "Bob Tan", text: "This one works." }]);
    await fixture.wait(REVISE_DEBOUNCE_MS);

    expect(fixture.nativeCaptionsVisible()).toBe(false);
  });

  it("sends and records nothing more once the overlay is hidden mid-queue", async () => {
    const fixture = createFixture();
    // The first line's answer never comes back, so the sentences behind it sit
    // in the meeting queue — exactly where the screen-share switch finds them.
    fixture.hold("Good morning.");

    await fixture.render([{ speaker: "Alice Chen", text: "Good morning. Let's" }]);
    await fixture.render([{ speaker: "Alice Chen", text: "Good morning. Let's begin. So" }]);
    await fixture.render([
      { speaker: "Alice Chen", text: "Good morning. Let's begin. So it goes. And" }
    ]);

    expect(fixture.draftRequests).toEqual(["Good morning."]);

    fixture.setOverlayHidden(true);
    await fixture.release("Good morning.");
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    // 「隐藏译文（共享屏幕）」 promises that no meeting text is sent and none is
    // written from that moment, whatever was queued before the click.
    expect(fixture.draftRequests).toEqual(["Good morning."]);
    expect(fixture.recorded).toEqual([]);
  });

  it("keeps the line already written when the recognizer corrects it after the fact", async () => {
    const fixture = createFixture();
    // The channel holds this line, so its record waits in the queue while the
    // recognizer rewrites the same sentence.
    fixture.hold("Hi everyone.");

    await fixture.render([{ speaker: "Alice Chen", text: "Hi everyone." }]);
    await fixture.render([{ speaker: "Alice Chen", text: "Hi everyone. Let's" }]);
    await fixture.render([{ speaker: "Alice Chen", text: "Hey everyone. Let's" }]);
    await fixture.release("Hi everyone.");
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    // A line that reached the record stays in it: the transcript holds the
    // wording that was heard and the correction beside it, and never reaches
    // back to delete or rewrite what is already written.
    expect(storedSources(fixture.recorded)).toEqual(["Hi everyone.", "Hey everyone."]);
  });

  it("records a sentence the speaker really says twice as two lines", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "Okay." }]);
    await fixture.render([]);
    await fixture.wait(2_000);

    // Said again, in a new turn. Two sentences were spoken, so the record has
    // two lines — identical wording is not a sign of a repeat to be folded.
    await fixture.render([{ speaker: "Alice Chen", text: "Okay." }]);
    await fixture.render([]);
    await fixture.wait(2_000);

    expect(storedSources(fixture.recorded)).toEqual(["Okay.", "Okay."]);
  });

  it("records a settled cue once when its end arrives twice", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "Good morning everyone." }]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);
    await fixture.render([]);
    await fixture.wait(1_800);

    // The same end again, while the line is still the one on screen. One cue
    // settled, so it is written once however often it is handed over.
    await fixture.redeliverLastCueEnd();

    expect(storedSources(fixture.recorded)).toEqual(["Good morning everyone."]);
  });
});

/** What the D7 store would hold after these lines were handed to it. */
function storedSources(recorded: RecordedLine[]): string[] | undefined {
  const stored = recorded.reduce<MeetingTranscriptSession | null>(
    (session, line, index) =>
      appendTranscriptLine(session, {
        sessionId: "meeting-1",
        host: "meet.google.com",
        title: "Weekly sync",
        atMs: 1_000 + index,
        speaker: line.speaker ?? null,
        source: line.source,
        translation: line.translation
      }),
    null
  );
  return stored?.lines.map((line) => line.source);
}
