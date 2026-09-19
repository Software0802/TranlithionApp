import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPTION_SETTLE_DELAY_MS,
  NetflixCaptionAdapter
} from "../src/content/adapters/netflix-caption-adapter";
import type { SubtitleAdapterEvent } from "../src/content/adapters/types";

/**
 * Drives the real adapter against a synthetic caption container with a fully
 * controllable playback clock. This is the regression guard for the flicker
 * bug: Netflix empties and refills the container while the same line is still
 * on screen, and an empty read must not be treated as the end of a cue.
 */

const SETTLE_MS = CAPTION_SETTLE_DELAY_MS;
const TICK_MS = 200;

function createFixture() {
  let mediaTimeMs = 0;
  let captionText = "";
  let notifyMutation: (() => void) | null = null;
  let rootToken = 0;

  const rect = { width: 700, height: 40, left: 40, top: 380, right: 740, bottom: 420 };
  const makeRoot = () => ({
    get innerText() {
      return captionText;
    },
    get textContent() {
      return captionText;
    },
    getBoundingClientRect: () => rect,
    style: {
      setProperty: () => undefined,
      getPropertyValue: () => "",
      getPropertyPriority: () => "",
      removeProperty: () => undefined
    },
    // Distinct object identity so discoverRoot treats this as a new element.
    __token: ++rootToken
  });
  let root: ReturnType<typeof makeRoot> = makeRoot();

  const video = {
    get currentTime() {
      return mediaTimeMs / 1_000;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 450, width: 800, height: 450 })
  };

  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("document", {
    querySelectorAll: (selector: string) =>
      selector === '[data-uia="player-subtitle-text"]' ? [root] : [],
    getElementById: () => null,
    createElement: (tag: string) => {
      if (tag !== "style") {
        throw new Error(`unexpected createElement(${tag})`);
      }
      return {
        id: "",
        textContent: "",
        remove: () => undefined
      };
    },
    head: {
      append: () => undefined
    }
  });
  vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible", display: "block" }));
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
  const adapter = new NetflixCaptionAdapter(video as unknown as HTMLVideoElement);
  adapter.start((event: SubtitleAdapterEvent) => {
    if (event.type === "cue-start") {
      events.push(`start:${event.cue.text}`);
    } else if (event.type === "cue-revise") {
      events.push(`revise:${event.cue.text}`);
    } else if (event.type === "cue-end") {
      events.push("end");
    }
  });

  return {
    adapter,
    events,
    /** Writes caption text and lets the adapter observe the change. */
    async render(text: string) {
      captionText = text;
      notifyMutation?.();
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
    },
    /** Advances playback while the adapter's heartbeat runs. */
    async play(ms: number) {
      const steps = Math.ceil(ms / TICK_MS);
      for (let step = 0; step < steps; step += 1) {
        mediaTimeMs += Math.min(TICK_MS, ms - step * TICK_MS);
        await vi.advanceTimersByTimeAsync(TICK_MS);
      }
    },
    /** Advances wall-clock time only, as when the viewer pauses. */
    async wait(ms: number) {
      await vi.advanceTimersByTimeAsync(ms);
    },
    seekTo(ms: number) {
      mediaTimeMs = ms;
    },
    /** Simulates Netflix rebuilding the timed-text node for the same line. */
    replaceRoot() {
      root = makeRoot();
    }
  };
}

describe("Netflix cue lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts a cue once the caption text settles", async () => {
    const fixture = createFixture();

    await fixture.render("こんにちは");

    expect(fixture.events).toEqual(["start:こんにちは"]);
  });

  it("survives a repaint that empties and refills the same line", async () => {
    const fixture = createFixture();
    await fixture.render("こんにちは");
    fixture.events.length = 0;

    // Netflix clears the node and repaints the identical text a frame later.
    await fixture.render("");
    await fixture.play(100);
    await fixture.render("こんにちは");

    // No end, and no duplicate start: the caption never left the screen.
    expect(fixture.events).toEqual([]);
  });

  it("keeps the caption while playback is paused", async () => {
    const fixture = createFixture();
    await fixture.render("こんにちは");
    fixture.events.length = 0;

    await fixture.render("");
    // Five seconds of wall clock with the video paused.
    await fixture.wait(5_000);

    expect(fixture.events).toEqual([]);
  });

  it("ends the cue once playback moves past the caption", async () => {
    const fixture = createFixture();
    await fixture.render("こんにちは");
    fixture.events.length = 0;

    await fixture.render("");
    await fixture.play(1_400);

    expect(fixture.events).toEqual(["end"]);
  });

  it("revises in place when the on-screen line grows or is rewritten", async () => {
    const fixture = createFixture();
    await fixture.render("こんにちは");
    fixture.events.length = 0;

    await fixture.render("こんにちは 世界");

    // No end/start churn: Netflix often completes one slot across multiple DOM writes.
    expect(fixture.events).toEqual(["revise:こんにちは 世界"]);
  });

  it("revises when a different line replaces the old one without an empty gap", async () => {
    const fixture = createFixture();
    await fixture.render("こんにちは");
    fixture.events.length = 0;

    await fixture.render("ありがとう");

    expect(fixture.events).toEqual(["revise:ありがとう"]);
  });

  it("ends only after empty hold, even if the line was revised earlier", async () => {
    const fixture = createFixture();
    await fixture.render("こんにちは");
    await fixture.render("こんにちは 世界");
    fixture.events.length = 0;

    await fixture.render("");
    await fixture.play(1_400);

    expect(fixture.events).toEqual(["end"]);
  });

  it("ends the cue when the viewer seeks backwards", async () => {
    const fixture = createFixture();
    await fixture.render("こんにちは");
    await fixture.play(600);
    fixture.events.length = 0;

    await fixture.render("");
    fixture.seekTo(0);
    await fixture.wait(TICK_MS);

    expect(fixture.events).toEqual(["end"]);
  });

  it("does not restart a cue while its text stays unchanged", async () => {
    const fixture = createFixture();
    await fixture.render("こんにちは");
    fixture.events.length = 0;

    await fixture.render("こんにちは");
    await fixture.play(400);

    expect(fixture.events).toEqual([]);
  });

  it("keeps the cue when Netflix swaps the caption element for the same line", async () => {
    const fixture = createFixture();
    await fixture.render("こんにちは");
    fixture.events.length = 0;

    fixture.replaceRoot();
    await fixture.wait(750);

    expect(fixture.events).toEqual([]);
  });
});
