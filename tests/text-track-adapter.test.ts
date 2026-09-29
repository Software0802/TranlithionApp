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

function track(language: string, label: string, cues: FakeCue[], timeline: FakeCue[] = cues) {
  const listeners = new Set<() => void>();
  return {
    kind: "subtitles",
    language,
    label,
    mode: "disabled",
    activeCues: cues,
    /** Every line of the track, as `TextTrack.cues` lists it. */
    cues: timeline as FakeCue[] | null,
    addEventListener: (_type: string, handler: () => void) => listeners.add(handler),
    removeEventListener: (_type: string, handler: () => void) => listeners.delete(handler),
    /** Plays on to `active`, as the browser's cuechange would report it. */
    showOnly(active: FakeCue[]) {
      this.activeCues = active;
      for (const listener of [...listeners]) {
        listener();
      }
    }
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

describe("reading the lines still to come", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const timeline: FakeCue[] = [
    { startTime: 1, endTime: 2, text: "おはよう" },
    { startTime: 3, endTime: 4, text: "こんにちは" },
    { startTime: 5, endTime: 6, text: "こんばんは" },
    { startTime: 7, endTime: 8, text: "さようなら" }
  ];

  it("lists the next lines after the one on screen, soonest first", () => {
    // TextTrack.cues is ordered by the browser, but nothing here relies on it.
    const shuffled = [timeline[3], timeline[1], timeline[0], timeline[2]];
    const fixture = createFixture([track("ja", "日本語", [timeline[0]], shuffled)], "ja");

    expect(fixture.adapter.upcomingCues(1_000, 2).map((cue) => cue.text)).toEqual([
      "こんにちは",
      "こんばんは"
    ]);
  });

  it("builds each line exactly as it will be read once it is on screen", () => {
    // A translation prefetched for a line is only found again if the line
    // that comes on screen later carries the same id.
    const japanese = track("ja", "日本語", [timeline[0]], timeline);
    const fixture = createFixture([japanese], "ja");
    const [next] = fixture.adapter.upcomingCues(1_000, 1);

    fixture.events.length = 0;
    japanese.showOnly([timeline[1]]);

    const started = fixture.events.find((event) => event.type === "cue-start");
    expect(started?.type === "cue-start" ? started.cue.id : null).toBe(next?.id);
  });

  it("has nothing ahead when the track exposes no timeline", () => {
    const bare = track("ja", "日本語", [timeline[0]]);
    bare.cues = null;
    const fixture = createFixture([bare], "ja");

    expect(fixture.adapter.upcomingCues(0, 3)).toEqual([]);
  });
});
