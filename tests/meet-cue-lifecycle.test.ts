import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEET_CAPTION_SETTLE_DELAY_MS,
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
    querySelector: (selector: string) =>
      selector.includes('role="region"') || selector === ".a4cQT" ? region : null,
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
  const adapter = new MeetCaptionAdapter(clock);
  adapter.start((event: SubtitleAdapterEvent) => {
    if (event.type === "cue-start") {
      events.push(`start:${event.cue.speaker ?? "-"}|${event.cue.text}`);
    } else if (event.type === "cue-revise") {
      events.push(`revise:${event.cue.speaker ?? "-"}|${event.cue.text}`);
    } else if (event.type === "cue-end") {
      events.push("end");
    }
  });

  function rebuild(turns: Turn[]): void {
    region.children.length = 0;
    for (const turn of turns) {
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
    }
  }

  return {
    adapter,
    events,
    /** Renders the caption strip and lets the adapter observe the change. */
    async render(turns: Turn[]) {
      rebuild(turns);
      notifyMutation?.();
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

  it("recovers when the recognizer rewrites words it had already shown", async () => {
    const fixture = createFixture();
    await fixture.render([{ speaker: "Alice Chen", text: "Hi everyone." }]);
    fixture.events.length = 0;

    // Same block, corrected from scratch: the published prefix no longer
    // exists, so the adapter must not slice the new text against it. The
    // already-closed sentence is replaced whole rather than mangled.
    await fixture.render([{ speaker: "Alice Chen", text: "Hey everyone. Let's" }]);

    expect(fixture.events).toEqual([
      "end",
      "start:Alice Chen|Hey everyone.",
      "end",
      "start:Alice Chen|Let's"
    ]);
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
