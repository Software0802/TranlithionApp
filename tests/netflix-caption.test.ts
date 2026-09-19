import { describe, expect, it } from "vitest";
import {
  hasCaptionExpired,
  nativeCaptionHideCss,
  NETFLIX_CAPTION_SELECTORS,
  normalizeNetflixCaptionText
} from "../src/content/adapters/netflix-caption-adapter";
import { createSubtitleCue } from "../src/shared/subtitle";

describe("Netflix accessible caption adapter", () => {
  it("keeps the public rendered-caption selectors explicit", () => {
    expect(NETFLIX_CAPTION_SELECTORS).toEqual(expect.arrayContaining([
      '[data-uia="player-subtitle-text"]',
      ".player-timedtext-text-container"
    ]));
  });

  it("hides native captions with a selector stylesheet, not a single-node style", () => {
    const css = nativeCaptionHideCss();
    for (const selector of NETFLIX_CAPTION_SELECTORS) {
      expect(css).toContain(selector);
    }
    expect(css).toContain("opacity: 0 !important");
  });

  it("preserves caption annotations while normalizing visible text", () => {
    expect(normalizeNetflixCaptionText("\n [音楽] こんにちは <br> 世界 \u00a0 "))
      .toBe("[音楽] こんにちは 世界");
  });

  it("emits a standard cue for an accessible Netflix caption", () => {
    const cue = createSubtitleCue({
      source: "netflix-dom",
      startMs: 5_100,
      endMs: null,
      text: "ありがとう",
      isFinal: true
    });

    expect(cue).toMatchObject({
      source: "netflix-dom",
      startMs: 5_100,
      endMs: null,
      text: "ありがとう"
    });
  });
});

describe("caption expiry follows playback position", () => {
  it("holds the caption through a repaint that briefly empties the container", () => {
    // Netflix clears and refills the node within the same displayed line, so
    // playback has barely advanced between the empty read and the refill.
    expect(hasCaptionExpired(10_000, 10_050)).toBe(false);
    expect(hasCaptionExpired(10_000, 10_400)).toBe(false);
  });

  it("keeps the caption on screen indefinitely while paused", () => {
    // currentTime does not advance while paused, so the delta stays at zero no
    // matter how long the viewer waits.
    expect(hasCaptionExpired(10_000, 10_000)).toBe(false);
  });

  it("ends the caption once playback has genuinely moved past it", () => {
    expect(hasCaptionExpired(10_000, 11_200)).toBe(true);
    expect(hasCaptionExpired(10_000, 14_000)).toBe(true);
  });

  it("ends the caption immediately when the viewer seeks backwards", () => {
    expect(hasCaptionExpired(10_000, 4_000)).toBe(true);
  });

  it("ends the caption immediately when the viewer skips forward", () => {
    expect(hasCaptionExpired(10_000, 60_000)).toBe(true);
  });
});
