import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findMeetCaptionRegion,
  hasMeetCaptionExpired,
  MEET_CAPTION_REGION_SELECTORS,
  MEET_MAX_SEGMENT_CHARS,
  MEET_NATIVE_HIDE_ATTRIBUTE,
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
    querySelectorAll: (selector: string) => nodes.filter((node) => node.matches(selector)),
    querySelector: (selector: string) => nodes.find((node) => node.matches(selector)) ?? null
  });
}

describe("Meet caption region", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers the live region over Meet's obfuscated class names", () => {
    // Class names change between Meet releases, and a stale one can still be
    // in the page. The captions region keeps its role, so discovery has to
    // pick that one even when the class match comes first in the page.
    const classOnly = element({
      className: "a4cQT",
      children: [meetTurn("Bob Tan", "from the class node")]
    });
    const live = element({
      className: "Kq7Fxb",
      attributes: { role: "region", "aria-live": "polite" },
      children: [meetTurn("Alice Chen", "from the live region")]
    });
    stubDocument([classOnly, live]);

    const region = findMeetCaptionRegion(null);

    expect(region).not.toBeNull();
    expect(readMeetCaptionBlocks(region as Element)).toEqual([
      { speaker: "Alice Chen", text: "from the live region" }
    ]);
  });

  it("prefers a live region over a plain one when both hold caption rows", () => {
    // Both match on role, so only the aria-live tier separates them: the
    // strip Meet announces to a screen reader is the one being spoken into.
    const plain = element({
      attributes: { role: "region" },
      children: [meetTurn("Bob Tan", "from the plain region")]
    });
    const live = element({
      attributes: { role: "region", "aria-live": "polite" },
      children: [meetTurn("Alice Chen", "from the live region")]
    });
    stubDocument([plain, live]);

    expect(readMeetCaptionBlocks(findMeetCaptionRegion(null) as Element)).toEqual([
      { speaker: "Alice Chen", text: "from the live region" }
    ]);
  });

  it("finds the caption region whatever language its label is in", () => {
    // The label is localized, so nothing may depend on reading it: the role
    // plus the caption rows inside are what identify the strip.
    const french = element({
      attributes: { role: "region", "aria-label": "Sous-titres", "aria-live": "polite" },
      children: [meetTurn("Alice Chen", "bonjour tout le monde")]
    });
    stubDocument([french]);

    expect(readMeetCaptionBlocks(findMeetCaptionRegion(null) as Element)).toEqual([
      { speaker: "Alice Chen", text: "bonjour tout le monde" }
    ]);
  });

  it("skips a region of the meeting UI that carries no captions", () => {
    const settingsPanel = element({
      attributes: { role: "region", "aria-live": "polite" },
      children: [{ className: "settings-row", text: "Captions settings" }]
    });
    const captions = element({
      className: "a4cQT",
      children: [meetTurn("Bob Tan", "from the caption strip")]
    });
    stubDocument([settingsPanel, captions]);

    expect(readMeetCaptionBlocks(findMeetCaptionRegion(null) as Element)).toEqual([
      { speaker: "Bob Tan", text: "from the caption strip" }
    ]);
  });

  it("reports no region at all when nothing in the page holds caption rows", () => {
    const unrelated = element({
      attributes: { role: "region", "aria-live": "polite" },
      children: [{ className: "chat-row", text: "someone typed something" }]
    });
    stubDocument([unrelated]);

    expect(findMeetCaptionRegion(null)).toBeNull();
  });

  it("keeps reading the region it already found", () => {
    const live = element({
      attributes: { role: "region", "aria-live": "polite" },
      children: [meetTurn("Alice Chen", "still here")]
    });
    stubDocument([]);

    expect(findMeetCaptionRegion(asElement(live))).toBe(asElement(live));
  });

  it("hides only the region it is reading, not everything that looks like one", () => {
    const css = nativeMeetCaptionHideCss();

    // Scoped to the marker attribute the adapter puts on that one region: a
    // captions-settings panel matching the same selectors stays visible.
    expect(css).toBe(`[${MEET_NATIVE_HIDE_ATTRIBUTE}] { opacity: 0 !important; }`);
    for (const selector of MEET_CAPTION_REGION_SELECTORS) {
      expect(css).not.toContain(selector);
    }
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

  it("reads nothing when Meet wraps its turns in a layout we do not know", () => {
    // Treating every child of the region as a turn would parse this wrapper
    // as one turn, and the first speaker and text nodes inside it belong to
    // the oldest line on the strip: the adapter would sit on that line,
    // retranslating it while new speech scrolled past, and say nothing.
    const region = element({
      className: "a4cQT",
      children: [
        {
          className: "scroller",
          children: [
            {
              className: "row",
              children: [
                { className: "zs7s8d", text: "Alice Chen" },
                { className: "bh44bd", text: "the first thing said" }
              ]
            },
            {
              className: "row",
              children: [
                { className: "zs7s8d", text: "Bob Tan" },
                { className: "bh44bd", text: "what is being said now" }
              ]
            }
          ]
        }
      ]
    });

    expect(readMeetCaptionBlocks(asElement(region))).toEqual([]);
  });

  it("keeps a long display name instead of second-guessing the selector", () => {
    // Google account names carry titles, team suffixes and parenthetical
    // roles. Dropping one on length would silently take that person's name
    // off the overlay, out of the translation context and out of the D7
    // transcript — the declared selector is the discriminator, not a guess
    // about how long a name can be.
    const name = "Alexandra Constantinescu-Petrescu | Platform Engineering (she/her)";
    const block = element({
      className: "nMcdL",
      children: [
        { className: "zs7s8d", text: name },
        { className: "bh44bd", text: "Agreed." }
      ]
    });

    expect(parseMeetCaptionBlock(asElement(block))).toEqual({ speaker: name, text: "Agreed." });
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

  it("does not cut after a title the name follows", () => {
    // A title comes with its name in the same breath. Cutting between them
    // would translate and record the honorific on its own and leave the name
    // it belongs to without it.
    expect(settledSegmentEnd("Mr. Chen will")).toBe(0);
    const whole = "Mr. Chen will present.";
    expect(whole.slice(0, settledSegmentEnd(whole))).toBe(whole);

    const finished = "Mr. Chen will present. Then";
    expect(finished.slice(0, settledSegmentEnd(finished))).toBe("Mr. Chen will present.");
  });

  it("settles a short utterance that is the whole of what was said", () => {
    // "No." is a complete answer, and one of the commonest things anyone says
    // in a meeting. Holding it open would leave it untranslated until the
    // speaker happened to say something else.
    expect(settledSegmentEnd("No.")).toBe(3);
    expect(settledSegmentEnd("Hi.")).toBe(3);
    expect(settledSegmentEnd("Let us ask Jo.")).toBe(14);
    expect(settledSegmentEnd("Okay.")).toBe(5);
  });

  it("does not cut after initials or an initialism the sentence carries on past", () => {
    expect(settledSegmentEnd("the U.S. government")).toBe(0);
    expect(settledSegmentEnd("J. R. Smith said")).toBe(0);

    const finished = "J. R. Smith runs the U.S. office. Next";
    expect(finished.slice(0, settledSegmentEnd(finished))).toBe(
      "J. R. Smith runs the U.S. office."
    );
  });

  it("does not cut after the Latin abbreviations that end in a stop", () => {
    expect(settledSegmentEnd("a few people, e.g. Alice and")).toBe(0);
    expect(settledSegmentEnd("slides, charts, etc. before")).toBe(0);
  });

  it("settles after an ordinary capitalized word", () => {
    // The guard is about titles and initials, not about capitals: a normal
    // word that finishes a sentence still finishes it.
    const text = "I said no. Fine. Then";
    expect(text.slice(0, settledSegmentEnd(text))).toBe("I said no. Fine.");
    expect(settledSegmentEnd("We ship in the US. Soon")).toBeGreaterThan(0);
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
