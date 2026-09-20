import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEET_CAPTION_SETTLE_DELAY_MS,
  MEET_NATIVE_HIDE_STYLE_ID,
  MEET_REGION_POLL_INTERVAL_MS,
  MeetCaptionAdapter
} from "../src/content/adapters/meet-caption-adapter";
import type { SubtitleAdapterEvent } from "../src/content/adapters/types";
import {
  MEETING_FINAL_CHANNEL_TIMEOUT_MS,
  MEETING_LLM_CHANNEL_TIMEOUT_MS
} from "../src/shared/meeting";
import { SubtitleController } from "../src/content/subtitle-controller";
import {
  appendTranscriptLine,
  type MeetingTranscriptSession
} from "../src/shared/meeting-transcript";
import { DEFAULT_SETTINGS, publicSettings } from "../src/shared/settings";
import type {
  PublicTranslationSettings,
  RuntimeStatus,
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

function createFixture(overrides: Partial<PublicTranslationSettings> = {}) {
  let wallClockMs = 0;
  let notifyMutation: (() => void) | null = null;

  const region = element({
    className: "a4cQT",
    attributes: { role: "region", "aria-label": "Captions" }
  });
  /** Stylesheets currently in the document head, by id. */
  const documentStyles = new Map<string, FakeNode>();
  /** Every element the page built, so the overlay can be read back. */
  const createdNodes: FakeNode[] = [];

  const draftRequests: string[] = [];
  const modelRequests: string[] = [];
  const recorded: RecordedLine[] = [];
  /** Everything the popup was told, newest last. */
  const statuses: RuntimeStatus[] = [];
  /** Source lines the channel refuses to translate. */
  const draftFailures: string[] = [];
  /** Source lines whose answer is held until the test releases it. */
  const heldSources = new Set<string>();
  const heldAnswers = new Map<string, (response: unknown) => void>();
  /** The same, for the chat model, plus the request it is still answering. */
  const heldModelSources = new Set<string>();
  let inFlightModel: { text: string; resolve: (response: TranslationResponse) => void } | null =
    null;

  function modelAnswer(text: string): TranslationResponse {
    return {
      ok: true,
      translation: { text: `[llm] ${text}`, provider: "mock", latencyMs: 1, entityHints: [] }
    };
  }

  /** Enough of an element for the Overlay, and readable back as what it shows. */
  function createNode(tag: string): FakeNode {
    const attributes: Record<string, string> = {};
    const node: FakeNode = {
      tagName: tag.toUpperCase(),
      id: "",
      className: "",
      textContent: "",
      hidden: false,
      lang: "",
      parentElement: null,
      style: { setProperty: () => undefined } as Record<string, unknown>,
      dataset: {},
      attributes,
      classList: { toggle: () => undefined },
      setAttribute: (name: string, value: string) => {
        attributes[name] = value;
      },
      append: () => undefined,
      attachShadow: () => ({ append: () => undefined }),
      remove: () => {
        documentStyles.delete(node.id);
      }
    };
    createdNodes.push(node);
    return node;
  }

  /** The translation line the overlay is showing, or null when it is hidden. */
  function caption(): string | null {
    const host = createdNodes.find(
      (node) => "data-tranlithion-overlay" in (node.attributes as Record<string, string>)
    );
    const style = host?.style as Record<string, unknown> | undefined;
    if (style?.display !== "block") {
      return null;
    }
    const line = createdNodes.find((node) => node.className === "translation");
    return String(line?.textContent ?? "");
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
          if (heldSources.has(text)) {
            return new Promise((resolve) => {
              heldAnswers.set(text, resolve);
            });
          }
          if (draftFailures.includes(text)) {
            return { ok: false };
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
  /** The cue a streamed token would belong to. */
  let openCueId = "";
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
      if (event.type === "cue-start" || event.type === "cue-revise") {
        openCueId = event.cue.id;
      }
      onEvent(event);
    });
  });

  const settings: PublicTranslationSettings = {
    ...publicSettings(DEFAULT_SETTINGS),
    meetingMode: true,
    meetingTranscript: true,
    draftProvider: "deepl",
    draftApiKeyConfigured: true,
    ...overrides
  };
  const controller = new SubtitleController(
    { kind: "page" },
    settings,
    async (cue: SubtitleCue): Promise<TranslationResponse> => {
      modelRequests.push(cue.text);
      // The background keeps only the newest meeting request, so a new one
      // aborts whatever it finds in flight.
      inFlightModel?.resolve({ ok: false, error: { code: "CANCELLED", message: "superseded" } });
      inFlightModel = null;
      if (!heldModelSources.has(cue.text)) {
        return modelAnswer(cue.text);
      }
      return new Promise<TranslationResponse>((resolve) => {
        inFlightModel = { text: cue.text, resolve };
      });
    },
    (status: RuntimeStatus) => {
      statuses.push(status);
    }
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
    caption,
    /** Whether Meet's own caption strip is readable to the user right now. */
    nativeCaptionsVisible: () => !documentStyles.has(MEET_NATIVE_HIDE_STYLE_ID),
    /** The one-click 「隐藏译文（共享屏幕）」 switch. */
    setOverlayHidden(hidden: boolean) {
      controller.updateSettings({ ...settings, meetingOverlayHidden: hidden });
    },
    /** The options page's target-language picker, mid-meeting. */
    setTargetLanguage(targetLanguage: PublicTranslationSettings["targetLanguage"]) {
      controller.updateSettings({ ...settings, targetLanguage });
    },
    /** Holds this line's translation until `release`, as a slow channel would. */
    hold(source: string) {
      heldSources.add(source);
    },
    /** The same for the chat model, so a request can be left in flight. */
    holdModel(source: string) {
      heldModelSources.add(source);
    },
    async releaseModel(source: string) {
      heldModelSources.delete(source);
      const pending = inFlightModel;
      inFlightModel = null;
      if (pending) {
        pending.resolve(modelAnswer(pending.text));
      }
      await vi.advanceTimersByTimeAsync(0);
    },
    /** One streamed token of the answer the model is still writing. */
    showPartial(text: string) {
      controller.showPartialTranslation(controller.sessionId, openCueId, text);
    },
    /** Hands the controller the cue-end it just saw a second time. */
    async redeliverLastCueEnd() {
      deliver?.(cueEnds[cueEnds.length - 1]);
      await vi.advanceTimersByTimeAsync(0);
    },
    async release(source: string) {
      heldSources.delete(source);
      heldAnswers.get(source)?.(
        draftFailures.includes(source) ? { ok: false } : { ok: true, text: `[zh] ${source}` }
      );
      heldAnswers.delete(source);
      await vi.advanceTimersByTimeAsync(0);
    },
    /** The last thing the popup was told. */
    lastStatus: () => statuses[statuses.length - 1],
    /** Every failure the popup was told about, in order. */
    errors: () => statuses.filter((status) => status.state === "error").map((s) => s.message),
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

  it("shows the sentence that just finished, not only the fragment after it", async () => {
    const fixture = createFixture();

    // One read carries the full stop and the words that follow it, so the
    // finished sentence is settled while the next cue is already open.
    await fixture.render([{ speaker: "Alice Chen", text: "Good morning. Let's" }]);

    expect(fixture.caption()).toBe("[zh] Good morning.");
  });

  it("never puts a finished sentence back over a newer line already on screen", async () => {
    const fixture = createFixture({ meetingFinalChannel: "llm" });
    // The finished sentence waits on the model while the line after it is
    // already readable on screen from the draft channel.
    fixture.holdModel("Good morning.");

    await fixture.render([{ speaker: "Alice Chen", text: "Good morning. Thanks" }]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    expect(fixture.caption()).toBe("[zh] Thanks");

    fixture.holdModel("Thanks");
    await fixture.releaseModel("Good morning.");

    expect(fixture.caption()).toBe("[zh] Thanks");
  });

  it("shows the model's answer as it is streamed in", async () => {
    const fixture = createFixture({ meetingFinalChannel: "llm", draftCaptions: false });
    fixture.holdModel("Good morning everyone.");

    await fixture.render([{ speaker: "Alice Chen", text: "Good morning everyone." }]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);
    fixture.showPartial("早上好");

    expect(fixture.caption()).toBe("早上好");
  });

  it("stops painting streamed tokens once the target language changes", async () => {
    const fixture = createFixture({ meetingFinalChannel: "llm", draftCaptions: false });
    fixture.holdModel("Good morning everyone.");

    await fixture.render([{ speaker: "Alice Chen", text: "Good morning everyone." }]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    // The model is still writing its answer when the user switches away from
    // the language it was asked for.
    fixture.setTargetLanguage("en");
    fixture.showPartial("早上好");

    expect(fixture.caption()).toBeNull();
  });

  it("drops an answer that comes back after the target language changed", async () => {
    const fixture = createFixture();
    fixture.hold("Good morning.");

    await fixture.render([{ speaker: "Alice Chen", text: "Good morning. Let's" }]);
    await fixture.wait(TICK_MS);

    fixture.setTargetLanguage("en");
    await fixture.release("Good morning.");

    // The answer is written in the language the user just switched away from.
    expect(fixture.caption()).not.toBe("[zh] Good morning.");
    expect(fixture.recorded).toEqual([]);

    await fixture.render([]);
    await fixture.wait(3_000);
    await fixture.render([{ speaker: "Alice Chen", text: "Good morning. Thanks" }]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    // Nor is it kept for the next time the same sentence is said.
    expect(fixture.draftRequests.filter((text) => text === "Good morning.")).toHaveLength(2);
  });

  it("translates a one-word answer once the turn is over", async () => {
    const fixture = createFixture();

    // "No." reads exactly like a title while it is the only text there, so
    // it waits — but the turn ending is what it was waiting for.
    await fixture.render([{ speaker: "Bob Tan", text: "No." }]);

    expect(fixture.draftRequests).toEqual([]);

    await fixture.render([]);
    await fixture.wait(3_000);

    expect(fixture.draftRequests).toEqual(["No."]);
    expect(fixture.recorded).toMatchObject([{ source: "No.", translation: "[zh] No." }]);
  });

  it("keeps a title with the sentence it belongs to", async () => {
    const fixture = createFixture();

    // The recognizer streams the honorific on its own before the name lands.
    await fixture.render([{ speaker: "Alice Chen", text: "Mr." }]);
    await fixture.render([{ speaker: "Alice Chen", text: "Mr. Chen will" }]);
    await fixture.render([{ speaker: "Alice Chen", text: "Mr. Chen will present. Then" }]);

    // One sentence: one request, and one transcript row that still has the
    // honorific in it.
    expect(fixture.draftRequests).toEqual(["Mr. Chen will present."]);
    expect(fixture.recorded).toMatchObject([
      { source: "Mr. Chen will present.", translation: "[zh] Mr. Chen will present." }
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

  it("finishes a settled line on the chat model while a cached line refreshes context", async () => {
    const fixture = createFixture({ meetingFinalChannel: "llm" });

    // Said once, so the next time these words come up they are painted from
    // local memory and only the background's context is refreshed.
    await fixture.render([{ speaker: "Alice Chen", text: "Okay." }]);
    await fixture.render([]);
    await fixture.wait(2_000);

    fixture.holdModel("Good morning everyone.");
    await fixture.render([{ speaker: "Bob Tan", text: "Good morning everyone. And" }]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    await fixture.render([
      { speaker: "Bob Tan", text: "Good morning everyone. And" },
      { speaker: "Carol Diaz", text: "Okay." }
    ]);
    await fixture.releaseModel("Good morning everyone.");
    await fixture.wait(2_400);

    // The refresh waits its turn instead of superseding the sentence still
    // being translated, which therefore still reaches the transcript.
    expect(fixture.recorded).toContainEqual({
      source: "Good morning everyone.",
      translation: "[llm] Good morning everyone.",
      speaker: "Bob Tan"
    });
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

  it("says so and gives Meet's captions back when a slow channel fails", async () => {
    const fixture = createFixture();
    // A hung channel: it takes its time and then answers with nothing, by
    // which point the line it was translating is no longer the one on screen.
    fixture.hold("Good morning.");
    fixture.hold("Let's");
    fixture.draftFailures.push("Good morning.");

    await fixture.render([{ speaker: "Alice Chen", text: "Good morning. Let's" }]);
    await fixture.wait(REVISE_DEBOUNCE_MS);

    expect(fixture.nativeCaptionsVisible()).toBe(false);

    await fixture.release("Good morning.");

    expect(fixture.nativeCaptionsVisible()).toBe(true);
    expect(fixture.lastStatus()?.state).toBe("error");
  });

  it("drops an over-budget line on the machine-translation channel", async () => {
    const fixture = createFixture();
    // Nothing newer paints either, so the only thing that could put the
    // skipped line on screen is the skipped line itself.
    fixture.hold("Good morning.");
    fixture.hold("Let's");

    await fixture.render([{ speaker: "Alice Chen", text: "Good morning. Let's" }]);
    await fixture.wait(MEETING_FINAL_CHANNEL_TIMEOUT_MS + TICK_MS);

    expect(fixture.errors().some((message) => message.includes("4 秒"))).toBe(true);

    await fixture.release("Good morning.");

    // What the popup said, what is on screen and what the transcript holds
    // have to agree: the line was skipped, so it appears in none of them.
    expect(fixture.caption()).toBeNull();
    expect(fixture.recorded).toEqual([]);
  });

  it("records a sentence answered in time even when its cue ends much later", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "Good morning." }]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    expect(fixture.caption()).toBe("[zh] Good morning.");

    // Alice leaves the finished sentence on screen and only then carries on,
    // so its cue ends long after the budget for translating it ran out. The
    // budget bounds waiting on the channel, not how long a speaker pauses.
    await fixture.wait(MEETING_FINAL_CHANNEL_TIMEOUT_MS + 2_000);
    await fixture.render([{ speaker: "Alice Chen", text: "Good morning. Thanks" }]);
    await fixture.wait(TICK_MS);

    expect(fixture.recorded).toMatchObject([
      { source: "Good morning.", translation: "[zh] Good morning." }
    ]);
  });

  it("does not judge a re-created cue id against an abandoned deadline", async () => {
    const fixture = createFixture();
    fixture.draftFailures.push("Hi everyone");

    await fixture.render([{ speaker: "Alice Chen", text: "Hi everyone" }]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);
    await fixture.wait(MEETING_FINAL_CHANNEL_TIMEOUT_MS + TICK_MS);

    // The recognizer rewrites the open line and then corrects itself back,
    // which rebuilds the cue id the first attempt ran under. That wording is
    // being asked for now, so it is not held to the abandoned deadline.
    await fixture.render([{ speaker: "Alice Chen", text: "Hi everybody" }]);
    await fixture.render([{ speaker: "Alice Chen", text: "Hi everyone" }]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    expect(fixture.draftRequests).toEqual(["Hi everyone", "Hi everyone"]);
    expect(fixture.errors().some((message) => message.includes("已跳过"))).toBe(false);
  });

  it("forgets a superseded wording's budget even while the overlay is hidden", async () => {
    const fixture = createFixture();
    fixture.draftFailures.push("Hi everyone");

    await fixture.render([{ speaker: "Alice Chen", text: "Hi everyone" }]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    // Screen share: nothing is translated or shown from here, but the line
    // the recognizer replaces is still replaced.
    fixture.setOverlayHidden(true);
    await fixture.render([{ speaker: "Alice Chen", text: "Hi everybody" }]);
    await fixture.wait(MEETING_FINAL_CHANNEL_TIMEOUT_MS + TICK_MS);

    fixture.setOverlayHidden(false);
    await fixture.render([{ speaker: "Alice Chen", text: "Hi everyone" }]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    // Back on screen, the corrected wording is asked for afresh rather than
    // judged against the deadline of an attempt the user never saw.
    expect(fixture.draftRequests).toEqual(["Hi everyone", "Hi everyone"]);
    expect(fixture.errors().some((message) => message.includes("已跳过"))).toBe(false);
  });

  it("tells the user once about a line the channel refused straight away", async () => {
    const fixture = createFixture();
    fixture.draftFailures.push("Good morning.");

    await fixture.render([{ speaker: "Alice Chen", text: "Good morning." }]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    expect(fixture.errors()).toHaveLength(1);

    // Alice holds the line on screen past its budget and only then stops, so
    // the settled sentence reaches the queue after the deadline. Its outcome
    // was decided in 200 ms: nothing here may claim it went unanswered.
    await fixture.wait(MEETING_FINAL_CHANNEL_TIMEOUT_MS + TICK_MS);
    await fixture.render([]);
    await fixture.wait(3_000);

    expect(fixture.errors()).toHaveLength(1);
    expect(fixture.errors().some((message) => message.includes("已跳过"))).toBe(false);
    expect(fixture.draftRequests).toEqual(["Good morning."]);
  });

  it("gives one sentence one budget however often it reaches the queue", async () => {
    const fixture = createFixture();
    fixture.hold("Good morning.");

    // Asked for once when it stops growing, and again when its cue ends and
    // it has to be recorded — one sentence, one deadline.
    await fixture.render([{ speaker: "Alice Chen", text: "Good morning." }]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);
    await fixture.render([]);
    await fixture.wait(MEETING_FINAL_CHANNEL_TIMEOUT_MS + TICK_MS);

    expect(fixture.draftRequests).toEqual(["Good morning."]);
    expect(fixture.errors()).toHaveLength(1);

    await fixture.release("Good morning.");

    expect(fixture.recorded).toEqual([]);
  });

  it("keeps a painted draft when the model runs over budget", async () => {
    const fixture = createFixture({ meetingFinalChannel: "llm" });
    fixture.holdModel("Good morning everyone.");

    await fixture.render([{ speaker: "Alice Chen", text: "Good morning everyone." }]);
    await fixture.wait(REVISE_DEBOUNCE_MS + MEETING_LLM_CHANNEL_TIMEOUT_MS + TICK_MS);

    // The draft is a real translation and the user is reading it: the model
    // giving up behind it is not a line they lost, so nothing contradicts
    // what is on screen and Meet's own strip stays out of the way.
    expect(fixture.caption()).toBe("[zh] Good morning everyone.");
    expect(fixture.nativeCaptionsVisible()).toBe(false);
    expect(fixture.errors()).toEqual([]);
  });

  it("counts the wait in the queue against a line's budget", async () => {
    const fixture = createFixture();
    fixture.hold("Good morning.");
    fixture.hold("Let's begin.");

    await fixture.render([{ speaker: "Alice Chen", text: "Good morning. Let's" }]);
    await fixture.render([{ speaker: "Alice Chen", text: "Good morning. Let's begin. So" }]);
    await fixture.wait(MEETING_FINAL_CHANNEL_TIMEOUT_MS + TICK_MS);

    // The second sentence spent its budget waiting behind the first, so it is
    // as stale as if the channel had never answered it: the answer that
    // arrives now belongs to a meeting that has moved on.
    await fixture.release("Let's begin.");

    expect(fixture.caption()).not.toBe("[zh] Let's begin.");
    expect(fixture.recorded).toEqual([]);
  });

  it("stays quiet when a context refresh behind a shown line runs over budget", async () => {
    const fixture = createFixture({ meetingFinalChannel: "llm" });
    await fixture.render([{ speaker: "Alice Chen", text: "Thanks." }]);
    await fixture.wait(REVISE_DEBOUNCE_MS + TICK_MS);

    expect(fixture.caption()).toBe("[llm] Thanks.");

    // Said again by someone else: painted from local memory, with the model
    // call behind it only refreshing the background's context.
    fixture.holdModel("Thanks.");
    await fixture.render([
      { speaker: "Alice Chen", text: "Thanks." },
      { speaker: "Bob Tan", text: "Thanks." }
    ]);
    await fixture.wait(MEETING_LLM_CHANNEL_TIMEOUT_MS + TICK_MS);

    // Nothing the user can see was skipped, so nothing is said about it and
    // Meet's own strip stays out of the way.
    expect(fixture.errors()).toEqual([]);
    expect(fixture.caption()).toBe("[llm] Thanks.");
    expect(fixture.nativeCaptionsVisible()).toBe(false);
  });

  it("drops a meeting line the chat model does not answer inside its budget", async () => {
    const fixture = createFixture({ meetingFinalChannel: "llm" });
    fixture.holdModel("Good morning.");

    await fixture.render([{ speaker: "Alice Chen", text: "Good morning. Let's" }]);
    await fixture.wait(MEETING_LLM_CHANNEL_TIMEOUT_MS + TICK_MS);

    // Over budget: the user is told, and the queue moved on rather than
    // letting one line hold up everything said after it.
    expect(fixture.errors().some((message) => message.includes("8 秒"))).toBe(true);
    expect(fixture.modelRequests).toContain("Let's");

    await fixture.releaseModel("Good morning.");

    // A call is minutes past that sentence by now: it is neither shown nor
    // written to the transcript as if it were the line being spoken.
    expect(fixture.caption()).not.toBe("[llm] Good morning.");
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
