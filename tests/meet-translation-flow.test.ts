import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEET_CAPTION_SETTLE_DELAY_MS,
  MEET_NATIVE_HIDE_STYLE_ID,
  MEET_REGION_POLL_INTERVAL_MS
} from "../src/content/adapters/meet-caption-adapter";
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
  cueId: string;
  retractedCueIds?: string[];
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
            speaker: cue.speaker,
            cueId: cue.id,
            retractedCueIds: message.retractedCueIds as string[] | undefined
          });
        }
        return undefined;
      }
    }
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

  it("carries a retraction to the correction even when it lands mid-translation", async () => {
    const fixture = createFixture();
    // The channel holds this line, so its record waits in the queue while the
    // recognizer takes the same sentence back.
    fixture.hold("Hi everyone.");

    await fixture.render([{ speaker: "Alice Chen", text: "Hi everyone." }]);
    await fixture.render([{ speaker: "Alice Chen", text: "Hi everyone. Let's" }]);
    await fixture.render([{ speaker: "Alice Chen", text: "Hey everyone. Let's" }]);
    await fixture.release("Hi everyone.");
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    // Folding what was recorded through the real store is the outcome that
    // matters: the withdrawn wording must not survive in the D7 transcript.
    expect(storedSources(fixture.recorded)).toEqual(["Hey everyone."]);
  });

  it("keeps a recorded line when a never-recorded sentence is taken back", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "Okay." }]);
    await fixture.render([
      { speaker: "Alice Chen", text: "Okay." },
      { speaker: "Bob Tan", text: "Okay." }
    ]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    // Bob's turn opened on a sentence boundary, so that cue is still open and
    // has never been recorded. The recognizer now corrects it — a take-back
    // of something the transcript never held, which must not reach back and
    // delete Alice's line just because it reads the same.
    await fixture.render([
      { speaker: "Alice Chen", text: "Okay." },
      { speaker: "Bob Tan", text: "Okey." }
    ]);
    await fixture.render([]);
    await fixture.wait(2_400);

    expect(storedSources(fixture.recorded)).toEqual(["Okay.", "Okey."]);
  });

  it("keeps a recorded line a take-back from the hidden window would have deleted", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "Okay." }]);
    await fixture.render([
      { speaker: "Alice Chen", text: "Okay." },
      { speaker: "Bob Tan", text: "Okay." }
    ]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    // Screen share: nothing is shown and nothing is recorded from here.
    fixture.setOverlayHidden(true);
    await fixture.render([
      { speaker: "Alice Chen", text: "Okay." },
      { speaker: "Bob Tan", text: "Okay, so about the budget." }
    ]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    fixture.setOverlayHidden(false);
    await fixture.render([
      { speaker: "Alice Chen", text: "Okay." },
      { speaker: "Bob Tan", text: "Okay, so about the budget." },
      { speaker: "Carol Diaz", text: "Thanks." }
    ]);
    await fixture.render([]);
    await fixture.wait(2_400);

    // Bob's withdrawn "Okay." was never recorded — it was taken back while
    // the overlay was hidden. Carrying that take-back out of the hidden
    // window would delete the only "Okay." in the transcript, which is
    // Alice's, and she really did say it.
    expect(storedSources(fixture.recorded)).toEqual(["Okay.", "Thanks."]);
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
        translation: line.translation,
        cueId: line.cueId,
        retractedCueIds: line.retractedCueIds
      }),
    null
  );
  return stored?.lines.map((line) => line.source);
}
