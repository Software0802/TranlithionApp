import { describe, expect, it } from "vitest";
import {
  hasMeetCaptionExpired,
  MEET_CAPTION_REGION_SELECTORS,
  MEET_MAX_SEGMENT_CHARS,
  nativeMeetCaptionHideCss,
  parseMeetCaptionBlock,
  readMeetCaptionBlocks,
  settledSegmentEnd
} from "../src/content/adapters/meet-caption-adapter";
import { asElement, element } from "./helpers/fake-dom";

/** The shape Google Meet renders for one speaker turn. */
function meetTurn(speaker: string, text: string) {
  return {
    className: "nMcdL bj4p3b",
    children: [
      { className: "adE6rb M6cG0d", children: [{ tag: "img", className: "r6DyN" }] },
      { className: "zs7s8d jxFHg", text: speaker },
      { className: "bh44bd VbkSUe", attributes: { jsname: "tgaKEf" }, text }
    ]
  };
}

describe("Meet caption region", () => {
  it("prefers semantic attributes over Meet's obfuscated class names", () => {
    // Class names change between Meet releases; the captions region keeps its
    // role and label, so those selectors have to be tried first.
    expect(MEET_CAPTION_REGION_SELECTORS[0]).toContain('role="region"');
    expect(MEET_CAPTION_REGION_SELECTORS).toContain(".a4cQT");
    expect(MEET_CAPTION_REGION_SELECTORS.indexOf(".a4cQT")).toBeGreaterThan(0);
  });

  it("hides Meet's own captions with a selector stylesheet", () => {
    const css = nativeMeetCaptionHideCss();
    for (const selector of MEET_CAPTION_REGION_SELECTORS) {
      expect(css).toContain(selector);
    }
    // Opacity rather than display: the text has to stay readable to innerText.
    expect(css).toContain("opacity: 0 !important");
  });
});

describe("Meet caption block parsing", () => {
  it("separates the speaker from what they said", () => {
    const block = parseMeetCaptionBlock(asElement(element(meetTurn("Alice Chen", "Good morning."))));

    expect(block).toEqual({ speaker: "Alice Chen", text: "Good morning." });
  });

  it("still finds the speaker when Meet renames its caption classes", () => {
    // Only the avatar / name / text row layout survives; the avatar image is
    // what marks the first text row as a display name rather than a sentence.
    const renamed = element({
      className: "xQ1a",
      children: [
        { className: "aa", children: [{ tag: "img" }] },
        { className: "bb", text: "Bob Tan" },
        { className: "cc", text: "Let's start with the roadmap." }
      ]
    });

    expect(parseMeetCaptionBlock(asElement(renamed))).toEqual({
      speaker: "Bob Tan",
      text: "Let's start with the roadmap."
    });
  });

  it("reports no speaker rather than guessing one out of a sentence", () => {
    const anonymous = element({
      className: "xQ1a",
      children: [{ className: "cc", text: "Sorry, could you repeat that?" }]
    });

    expect(parseMeetCaptionBlock(asElement(anonymous))).toEqual({
      speaker: null,
      text: "Sorry, could you repeat that?"
    });
  });

  it("does not mistake a long first line for a display name", () => {
    const sentence = "We should postpone the launch until the security review is done.";
    const block = element({
      className: "xQ1a",
      children: [
        { className: "aa", children: [{ tag: "img" }] },
        { className: "bb", text: sentence },
        { className: "cc", text: "Agreed." }
      ]
    });

    // Falling back to "first row is the name" here would delete a real
    // sentence from the caption, so the whole block stays as text.
    expect(parseMeetCaptionBlock(asElement(block)).speaker).toBeNull();
    expect(parseMeetCaptionBlock(asElement(block)).text).toContain(sentence);
  });

  it("reads every rendered turn in order, oldest first", () => {
    const region = element({
      className: "a4cQT",
      attributes: { role: "region", "aria-label": "Captions" },
      children: [
        meetTurn("Alice Chen", "Good morning."),
        meetTurn("Bob Tan", "早上好。"),
        meetTurn("Alice Chen", "")
      ]
    });

    expect(readMeetCaptionBlocks(asElement(region))).toEqual([
      { speaker: "Alice Chen", text: "Good morning." },
      { speaker: "Bob Tan", text: "早上好。" }
    ]);
  });
});

describe("meeting caption expiry follows the wall clock", () => {
  it("holds the caption through a repaint that briefly empties the strip", () => {
    expect(hasMeetCaptionExpired(10_000, 10_100)).toBe(false);
    expect(hasMeetCaptionExpired(10_000, 11_000)).toBe(false);
  });

  it("ends the turn once the strip has stayed clear", () => {
    expect(hasMeetCaptionExpired(10_000, 11_600)).toBe(true);
    expect(hasMeetCaptionExpired(10_000, 30_000)).toBe(true);
  });

  it("ends the turn if the clock ever reads backwards", () => {
    expect(hasMeetCaptionExpired(10_000, 9_000)).toBe(true);
  });
});

describe("settled segment splitting", () => {
  it("leaves an unfinished clause open for more words", () => {
    expect(settledSegmentEnd("we should probably")).toBe(0);
  });

  it("cuts after a finished sentence", () => {
    const text = "Good morning. Let's";
    expect(text.slice(0, settledSegmentEnd(text))).toBe("Good morning.");
    expect(text.slice(settledSegmentEnd(text)).trim()).toBe("Let's");
  });

  it("cuts after the last terminator so one revision settles everything it can", () => {
    const text = "Good morning. Thanks for joining. Let's";
    expect(text.slice(0, settledSegmentEnd(text))).toBe("Good morning. Thanks for joining.");
  });

  it("cuts after CJK terminators, which carry no trailing space", () => {
    expect("早上好。我们开始吧".slice(0, settledSegmentEnd("早上好。我们开始吧"))).toBe("早上好。");
  });

  it("does not cut inside a figure or after a title", () => {
    // Splitting here would hand the translator "Mr." on its own line.
    expect(settledSegmentEnd("Q3.5 revenue was")).toBe(0);
    expect(settledSegmentEnd("Mr. Lee will")).toBe(0);
    const text = "Mr. Lee will present. Then";
    expect(text.slice(0, settledSegmentEnd(text))).toBe("Mr. Lee will present.");
  });

  it("caps an unpunctuated run on a word boundary", () => {
    // Some recognizers emit no punctuation at all; without a cap the same
    // growing paragraph would be retranslated in full on every revision.
    const long = "word ".repeat(80).trim();
    const cut = settledSegmentEnd(long);

    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThanOrEqual(MEET_MAX_SEGMENT_CHARS);
    expect(long.slice(0, cut).trim().endsWith("word")).toBe(true);
  });
});
