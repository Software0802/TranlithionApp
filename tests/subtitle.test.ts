import { describe, expect, it } from "vitest";
import {
  createSubtitleCue,
  hashSubtitleText,
  isCueWithinPlaybackWindow,
  normalizeSubtitleText
} from "../src/shared/subtitle";

describe("subtitle normalization", () => {
  it("removes WebVTT markup and normalizes entities and whitespace", () => {
    expect(normalizeSubtitleText("<c.green>こんにちは</c><br> &nbsp;世界&nbsp;"))
      .toBe("こんにちは 世界");
  });

  it("creates deterministic usable cues", () => {
    const cue = createSubtitleCue({
      source: "text-track",
      startMs: 101.2,
      endMs: 2_250.9,
      text: " <v 佐藤>ありがとう</v> "
    });

    expect(cue).toMatchObject({
      startMs: 101,
      endMs: 2251,
      text: "ありがとう",
      source: "text-track",
      isFinal: true
    });
    expect(cue?.id).toContain(hashSubtitleText("ありがとう"));
  });

  it("does not show a completed cue after its playback window", () => {
    const cue = createSubtitleCue({
      source: "text-track",
      startMs: 1_000,
      endMs: 2_000,
      text: "次の駅です"
    });
    expect(cue).not.toBeNull();
    expect(isCueWithinPlaybackWindow(cue!, 2_120)).toBe(true);
    expect(isCueWithinPlaybackWindow(cue!, 2_121)).toBe(false);
  });
});
