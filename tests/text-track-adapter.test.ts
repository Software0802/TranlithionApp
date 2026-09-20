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

  it("says the captions are unavailable when the new language has no track", () => {
    const fixture = createFixture(
      [track("ja", "日本語", [{ startTime: 1, endTime: 2, text: "おはよう" }])],
      "ja"
    );

    fixture.events.length = 0;
    fixture.adapter.setSourceLanguage("zh-CN");

    // Better to say nothing is readable than to keep translating Japanese as
    // if it were the Chinese the user asked for.
    const availability = fixture.events.filter((event) => event.type === "availability");
    expect(availability.at(-1)).toEqual({
      type: "availability",
      source: "text-track",
      available: false
    });
    expect(fixture.events.some((event) => event.type === "cue-start")).toBe(false);
  });
});
