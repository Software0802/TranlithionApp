import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findMeetCaptionRegion,
  hasMeetCaptionExpired,
  MEET_CAPTION_REGION_SELECTORS,
  MEET_MAX_SEGMENT_CHARS,
  nativeMeetCaptionHideCss,
  parseMeetCaptionBlock,
  readMeetCaptionBlocks,
  settledSegmentEnd
} from "../src/content/adapters/meet-caption-adapter";
import { asElement, element, type FakeElement } from "./helpers/fake-dom";

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

/** A page exposing exactly these elements to a selector query, in order. */
function stubDocument(nodes: FakeElement[]): void {
  vi.stubGlobal("document", {
    querySelector: (selector: string) => nodes.find((node) => node.matches(selector)) ?? null
  });
}

describe("Meet caption region", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers the semantically labelled region over Meet's obfuscated class names", () => {
    // Class names change between Meet releases, and a stale one can still be
    // in the page. The captions region keeps its role and label, so discovery
    // has to pick that one even when the class match comes first in the page.
    const classOnly = element({
      className: "a4cQT",
      children: [meetTurn("Bob Tan", "from the class node")]
    });
    const labelled = element({
      className: "Kq7Fxb",
      attributes: { role: "region", "aria-label": "Captions" },
      children: [meetTurn("Alice Chen", "from the labelled region")]
    });
    stubDocument([classOnly, labelled]);

    const region = findMeetCaptionRegion(null);

    expect(region).not.toBeNull();
    expect(readMeetCaptionBlocks(region as Element)).toEqual([
      { speaker: "Alice Chen", text: "from the labelled region" }
    ]);
  });

  it("still finds the region when only the class name is there", () => {
    const classOnly = element({
      className: "a4cQT",
      children: [meetTurn("Bob Tan", "from the class node")]
    });
    stubDocument([classOnly]);

    expect(readMeetCaptionBlocks(findMeetCaptionRegion(null) as Element)).toEqual([
      { speaker: "Bob Tan", text: "from the class node" }
    ]);
  });

  it("keeps reading the region it already found", () => {
    const labelled = element({
      attributes: { role: "region", "aria-label": "Captions" },
      children: [meetTurn("Alice Chen", "still here")]
    });
    stubDocument([]);

    expect(findMeetCaptionRegion(asElement(labelled))).toBe(asElement(labelled));
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

  it("reports no speaker rather than guessing one out of a sentence", () => {
    const anonymous = element({
      className: "nMcdL",
      children: [{ className: "bh44bd", text: "Sorry, could you repeat that?" }]
    });

    expect(parseMeetCaptionBlock(asElement(anonymous))).toEqual({
      speaker: null,
      text: "Sorry, could you repeat that?"
    });
  });

  it("reads nothing at all when Meet renames every caption class", () => {
    // Guessing which row of an unknown layout is the display name would
    // eventually label a fragment of speech as a speaker and drop it from the
    // translation. Reading nothing is the honest answer; the extension then
    // tells the user it cannot see the captions.
    const renamed = {
      className: "xQ1a",
      children: [
        { className: "aa", children: [{ tag: "img" }] },
        { className: "bb", text: "Bob Tan" },
        { className: "cc", text: "Let's start with the roadmap." }
      ]
    };

    expect(parseMeetCaptionBlock(asElement(element(renamed)))).toEqual({
      speaker: null,
      text: ""
    });
    expect(
      readMeetCaptionBlocks(asElement(element({ className: "a4cQT", children: [renamed] })))
    ).toEqual([]);
  });

  it("does not accept a whole sentence as a display name", () => {
    const sentence = "We should postpone the launch until the security review is done.";
    const block = element({
      className: "nMcdL",
      children: [
        { className: "zs7s8d", text: sentence },
        { className: "bh44bd", text: "Agreed." }
      ]
    });

    expect(parseMeetCaptionBlock(asElement(block))).toEqual({ speaker: null, text: "Agreed." });
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

  it("does not cut inside a figure", () => {
    // A period with a digit behind it is not the end of anything.
    expect(settledSegmentEnd("Q3.5 revenue was")).toBe(0);
    expect(settledSegmentEnd("we shipped 2.1 last")).toBe(0);
  });

  it("settles a finished sentence even when it ends in a short word", () => {
    // "I said no." really is finished; holding it open waiting for a longer
    // sentence would leave the line untranslated until the turn ended.
    const text = "I said no. Then";
    expect(text.slice(0, settledSegmentEnd(text))).toBe("I said no.");
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
