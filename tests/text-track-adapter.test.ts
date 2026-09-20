import { afterEach, describe, expect, it, vi } from "vitest";
import { TextTrackAdapter } from "../src/content/adapters/text-track-adapter";
import type { SubtitleAdapterEvent } from "../src/content/adapters/types";
import type { SourceLanguage } from "../src/shared/types";

/**
 * Drives the real adapter against a synthetic `<video>` carrying more than one
 * subtitle track. The source language is a user setting, so the track the
 * adapter reads has to follow it: reading on from the old one would hand one
 * language's subtitles to a translator asked for another's.
 */

interface FakeCue {
  startTime: number;
  endTime: number;
  text: string;
}

function track(language: string, label: string, cues: FakeCue[]) {
  const listeners = new Set<() => void>();
  return {
    kind: "subtitles",
    language,
    label,
    mode: "disabled",
    activeCues: cues,
    addEventListener: (_type: string, handler: () => void) => listeners.add(handler),
    removeEventListener: (_type: string, handler: () => void) => listeners.delete(handler)
  };
}

function createFixture(tracks: ReturnType<typeof track>[], sourceLanguage: SourceLanguage) {
  vi.stubGlobal("window", globalThis);
  const textTracks = Object.assign(tracks, {
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  });
  const video = {
    currentTime: 12,
    textTracks,
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  };
  const events: SubtitleAdapterEvent[] = [];
  const adapter = new TextTrackAdapter(
    video as unknown as HTMLVideoElement,
    sourceLanguage
  );
  adapter.start((event) => events.push(event));
  return { adapter, events };
}

describe("reading the track the user asked for", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("switches to the track of the source language the user picked", () => {
    const fixture = createFixture(
      [
        track("ja", "日本語", [{ startTime: 1, endTime: 2, text: "おはよう" }]),
        track("en", "English", [{ startTime: 1, endTime: 2, text: "Good morning" }])
      ],
      "ja"
    );

    expect(
      fixture.events.filter((event) => event.type === "cue-start").map((event) =>
        event.type === "cue-start" ? event.cue.text : ""
      )
    ).toEqual(["おはよう"]);

    fixture.events.length = 0;
    fixture.adapter.setSourceLanguage("en");

    // The Japanese line is over as far as this session is concerned, and what
    // comes next is read off the English track.
    expect(fixture.events.map((event) => event.type)).toContain("cue-end");
    expect(
      fixture.events.filter((event) => event.type === "cue-start").map((event) =>
        event.type === "cue-start" ? event.cue.text : ""
      )
    ).toEqual(["Good morning"]);
  });

  it("leaves the line on screen alone when the same track is chosen again", () => {
    // One readable track is what the viewer can see, whichever language the
    // picker is set to — so the switch lands back on it. Ending and
    // restarting the line the viewer is mid-way through reading would blank
    // its translation for nothing.
    const fixture = createFixture(
      [track("", "Subtitles", [{ startTime: 1, endTime: 2, text: "Good morning" }])],
      "ja"
    );

    fixture.events.length = 0;
    fixture.adapter.setSourceLanguage("en");

    expect(fixture.events).toEqual([]);
  });

  it("stops reading the old track even while the new one has nothing on screen", () => {
    const fixture = createFixture(
      [
        track("ja", "日本語", [{ startTime: 1, endTime: 2, text: "おはよう" }]),
        track("en", "English", [])
      ],
      "ja"
    );

    fixture.events.length = 0;
    fixture.adapter.setSourceLanguage("en");

    // The Japanese line ends here rather than staying on screen under a
    // translator that has been asked for English.
    expect(fixture.events.filter((event) => event.type === "cue-end")).toHaveLength(1);
    expect(fixture.events.some((event) => event.type === "cue-start")).toBe(false);
  });
});
