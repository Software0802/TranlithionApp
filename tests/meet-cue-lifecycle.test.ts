import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEET_CAPTION_SETTLE_DELAY_MS,
  MEET_NATIVE_HIDE_ATTRIBUTE,
  MEET_REGION_POLL_INTERVAL_MS,
  MeetCaptionAdapter
} from "../src/content/adapters/meet-caption-adapter";
import type { SubtitleAdapterEvent } from "../src/content/adapters/types";
import type { ClockSource } from "../src/content/clock";
import { element, type FakeElement } from "./helpers/fake-dom";

/**
 * Drives the real Meet adapter against a synthetic caption region with a fully
 * controllable wall clock.
 *
 * Meeting captions differ from film captions in exactly the two ways this
 * guards: the recognizer rewrites a line many times before it settles, and
 * there is no playback position, so the end of a turn is a wall-clock decision.
 */

const SETTLE_MS = MEET_CAPTION_SETTLE_DELAY_MS;
const TICK_MS = 200;

interface Turn {
  speaker: string;
  text: string;
}

function createFixture() {
  let wallClockMs = 0;
  let notifyMutation: (() => void) | null = null;

  const region = element({
    className: "a4cQT",
    attributes: { role: "region", "aria-label": "Captions" }
  });

  const clock: ClockSource = {
    nowMs: () => wallClockMs,
    rate: () => 1
  };

  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", {
    querySelectorAll: (selector: string) => (region.matches(selector) ? [region] : []),
    querySelector: (selector: string) => (region.matches(selector) ? region : null),
    getElementById: () => null,
    createElement: (tag: string) => {
      if (tag !== "style") {
        throw new Error(`unexpected createElement(${tag})`);
      }
      return { id: "", textContent: "", remove: () => undefined };
    },
    head: { append: () => undefined }
  });
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

  const events: string[] = [];
  const retractions: string[][] = [];
  /** The cue each published text went out as, so a test can name it back. */
  const cueIds = new Map<string, string>();
  const availability: boolean[] = [];
  const adapter = new MeetCaptionAdapter(clock);
  adapter.start((event: SubtitleAdapterEvent) => {
    if (event.type === "availability") {
      availability.push(event.available);
    }
    if (event.type === "cue-start") {
      events.push(`start:${event.cue.speaker ?? "-"}|${event.cue.text}`);
    } else if (event.type === "cue-revise") {
      events.push(`revise:${event.cue.speaker ?? "-"}|${event.cue.text}`);
    } else if (event.type === "cue-end") {
      events.push("end");
    }
    if (event.type === "cue-start" || event.type === "cue-revise") {
      cueIds.set(event.cue.text, event.cue.id);
    }
    if (event.type !== "availability" && event.type !== "cue-end" && event.retractedCueIds) {
      retractions.push(event.retractedCueIds);
    }
  });

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
            { className: "adE6rb", children: [{ tag: "img" }] },
            { className: "zs7s8d", text: turn.speaker },
            { className: "bh44bd", attributes: { jsname: "tgaKEf" }, text: turn.text }
          ]
        }) as FakeElement
      );
    });
  }

  return {
    adapter,
    events,
    retractions,
    cueIdOf: (text: string) => cueIds.get(text),
    availability,
    region,
    /** A strip whose rows none of the adapter's selectors can read. */
    async renderUnreadable(text: string) {
      region.children.length = 0;
      region.children.push(
        element({ className: "xQ1a", children: [{ className: "cc", text }] }) as FakeElement
      );
      notifyMutation?.();
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
    },
    /** Renders the caption strip and lets the adapter observe the change. */
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

describe("Meet cue lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts a cue carrying the speaker once the first partial renders", async () => {
    const fixture = createFixture();

    await fixture.render([{ speaker: "Alice Chen", text: "good morning" }]);

    expect(fixture.events).toEqual(["start:Alice Chen|good morning"]);
  });

  it("revises in place while the recognizer grows the same line", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "good" }]);
    fixture.events.length = 0;

    await fixture.render([{ speaker: "Alice Chen", text: "good morning" }]);
    await fixture.render([{ speaker: "Alice Chen", text: "good morning everyone" }]);

    // No end/start churn: one spoken sentence stays one on-screen slot.
    expect(fixture.events).toEqual([
      "revise:Alice Chen|good morning",
      "revise:Alice Chen|good morning everyone"
    ]);
  });

  it("closes a finished sentence and opens the next one", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "Good morning" }]);
    fixture.events.length = 0;

    await fixture.render([{ speaker: "Alice Chen", text: "Good morning. Let's" }]);

    expect(fixture.events).toEqual([
      "revise:Alice Chen|Good morning.",
      "end",
      "start:Alice Chen|Let's"
    ]);
  });

  it("only sends each settled sentence once as the turn continues", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "Good morning. Let's" }]);
    fixture.events.length = 0;

    await fixture.render([{ speaker: "Alice Chen", text: "Good morning. Let's begin." }]);

    // The already-published sentence is not retranslated with the new one.
    expect(fixture.events).toEqual(["revise:Alice Chen|Let's begin."]);
  });

  it("ends the line when the same person starts a new block", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "over to you" }]);
    fixture.events.length = 0;

    // Meet starts a fresh block at a paragraph even while the same person is
    // talking. Overwriting the open line would lose it before it was ever
    // translated, so the paragraph is a cue boundary like a speaker change.
    await fixture.render([
      { speaker: "Alice Chen", text: "over to you" },
      { speaker: "Alice Chen", text: "thanks" }
    ]);

    expect(fixture.events).toEqual(["end", "start:Alice Chen|thanks"]);
  });

  it("ends the line when the block it was reading is finalized and pushed up", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "over to you" }]);
    fixture.events.length = 0;

    // Meet punctuates the block it is leaving in the same update that appends
    // the next one. The line we were reading still ended; its text changing on
    // the way out must not hide that.
    await fixture.render([
      { speaker: "Alice Chen", text: "Over to you." },
      { speaker: "Alice Chen", text: "thanks" }
    ]);

    expect(fixture.events).toEqual(["end", "start:Alice Chen|thanks"]);
  });

  it("still revises in place when the recognizer corrects the open block", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "we should probably" }]);
    fixture.events.length = 0;

    // A correction rewrites the block being read rather than adding one, and
    // that is one line being refined, not two lines spoken.
    await fixture.render([{ speaker: "Alice Chen", text: "we shouldn't probably" }]);

    expect(fixture.events).toEqual(["revise:Alice Chen|we shouldn't probably"]);
  });

  it("ends the turn when a different person starts talking", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "over to you" }]);
    fixture.events.length = 0;

    await fixture.render([
      { speaker: "Alice Chen", text: "over to you" },
      { speaker: "Bob Tan", text: "thanks" }
    ]);

    expect(fixture.events).toEqual(["end", "start:Bob Tan|thanks"]);
  });

  it("keeps the cue through a repaint that briefly clears the strip", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "one moment" }]);
    fixture.events.length = 0;

    await fixture.render([]);
    await fixture.wait(800);
    await fixture.render([{ speaker: "Alice Chen", text: "one moment" }]);

    expect(fixture.events).toEqual([]);
  });

  it("ends the turn on the wall clock once the strip stays clear", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "that's all" }]);
    fixture.events.length = 0;

    await fixture.render([]);
    await fixture.wait(1_800);

    expect(fixture.events).toEqual(["end"]);
  });

  it("keeps the caption while Meet holds the last line on screen", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "that's all" }]);
    fixture.events.length = 0;

    // Meet leaves the finished line in the strip for several seconds; the
    // hold only starts once it is actually gone.
    await fixture.wait(6_000);

    expect(fixture.events).toEqual([]);
  });

  it("replaces a sentence the recognizer takes back instead of ending it", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "Hi everyone." }]);
    fixture.events.length = 0;

    // Same block, corrected after it had already been punctuated. Ending the
    // open cue here would hand "Hi everyone." to the translator and the
    // transcript as if it had been spoken, so the line is replaced and the
    // withdrawn wording is reported with its correction.
    await fixture.render([{ speaker: "Alice Chen", text: "Hey everyone. Let's" }]);

    expect(fixture.events).toEqual([
      "revise:Alice Chen|Hey everyone.",
      "end",
      "start:Alice Chen|Let's"
    ]);
    expect(fixture.retractions).toEqual([[fixture.cueIdOf("Hi everyone.")]]);
  });

  it("keeps the sentences a correction did not touch", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "One." }]);
    await fixture.render([{ speaker: "Alice Chen", text: "One. Two." }]);
    fixture.events.length = 0;
    fixture.retractions.length = 0;

    // Only the last sentence was rewritten. The one before it stays published:
    // re-publishing it would translate and record the same words twice.
    await fixture.render([{ speaker: "Alice Chen", text: "One. Two, and three." }]);

    expect(fixture.events).toEqual(["revise:Alice Chen|Two, and three."]);
    expect(fixture.retractions).toEqual([[fixture.cueIdOf("Two.")]]);
  });

  it("hides Meet's own strip only once it has read a caption out of it", async () => {
    const fixture = createFixture();
    fixture.adapter.setNativeCaptionVisibility(false);

    expect(fixture.region.getAttribute(MEET_NATIVE_HIDE_ATTRIBUTE)).toBeNull();

    await fixture.render([{ speaker: "Alice Chen", text: "hello" }]);

    expect(fixture.region.getAttribute(MEET_NATIVE_HIDE_ATTRIBUTE)).toBe("");
  });

  it("gives Meet's captions back when the strip stops being readable", async () => {
    const fixture = createFixture();
    fixture.adapter.setNativeCaptionVisibility(false);
    await fixture.render([{ speaker: "Alice Chen", text: "hello" }]);

    // Meet renames its caption classes mid-session: there is text on screen
    // and we cannot read a word of it. Keeping it hidden behind our stylesheet
    // would leave the user with nothing at all.
    await fixture.renderUnreadable("字幕がここにある");
    await fixture.wait(2_400);

    expect(fixture.region.getAttribute(MEET_NATIVE_HIDE_ATTRIBUTE)).toBeNull();
    expect(fixture.availability.at(-1)).toBe(false);
  });

  it("keeps the strip hidden while it is merely empty between utterances", async () => {
    const fixture = createFixture();
    fixture.adapter.setNativeCaptionVisibility(false);
    await fixture.render([{ speaker: "Alice Chen", text: "hello" }]);

    await fixture.render([]);
    await fixture.wait(4_000);

    expect(fixture.region.getAttribute(MEET_NATIVE_HIDE_ATTRIBUTE)).toBe("");
    expect(fixture.availability.at(-1)).toBe(true);
  });

  it("keeps the strip hidden while a speaker has yet to say a word", async () => {
    const fixture = createFixture();
    fixture.adapter.setNativeCaptionVisibility(false);
    await fixture.render([{ speaker: "Alice Chen", text: "hello" }]);

    // Meet attributes the row as soon as someone starts speaking, before the
    // recognizer has a word for it. Nothing is being withheld from the user
    // here — the row was read correctly and simply has nothing in it yet.
    await fixture.render([{ speaker: "Alice Chen", text: "" }]);
    await fixture.wait(2_400);

    expect(fixture.region.getAttribute(MEET_NATIVE_HIDE_ATTRIBUTE)).toBe("");
    expect(fixture.availability.at(-1)).toBe(true);
  });

  it("does not re-emit an unchanged line", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "still here" }]);
    fixture.events.length = 0;

    await fixture.render([{ speaker: "Alice Chen", text: "still here" }]);
    await fixture.wait(400);

    expect(fixture.events).toEqual([]);
  });

  it("stops reading the page once the adapter is stopped", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "hello" }]);
    fixture.adapter.stop();
    fixture.events.length = 0;

    await fixture.render([{ speaker: "Alice Chen", text: "hello again" }]);
    await fixture.wait(3_000);

    expect(fixture.events).toEqual([]);
  });
});
