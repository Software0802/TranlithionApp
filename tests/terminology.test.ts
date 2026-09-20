import { describe, expect, it } from "vitest";
import { applyTerminology, mergeTerminology } from "../src/shared/terminology";
import type { GlossaryEntry } from "../src/shared/types";

const term = (source: string, target: string, kind: GlossaryEntry["kind"] = "term") => ({
  source,
  target,
  kind
});

describe("fixed renderings on a machine translation", () => {
  it("renders a term the service left in the source language", () => {
    // DeepL and LibreTranslate take no glossary, so a product name comes back
    // untouched. The rendering the user pasted into settings is what the
    // caption has to show.
    expect(applyTerminology("我们在 Figma 里改了。", [term("Figma", "菲格玛")])).toBe(
      "我们在 菲格玛 里改了。"
    );
  });

  it("renders a speaker name the call taught us", () => {
    expect(
      applyTerminology("Alice Chen said yes.", [term("Alice Chen", "陈爱丽", "name")])
    ).toBe("陈爱丽 said yes.");
  });

  it("matches the spelling the user wrote and no other", () => {
    // `IT = 信息技术` is exactly the kind of entry a meeting glossary carries,
    // and an English caption is full of the word "it". Matching loosely would
    // put a term nobody said into the middle of a sentence.
    expect(applyTerminology("He said it plainly.", [term("IT", "信息技术")])).toBe(
      "He said it plainly."
    );
    expect(applyTerminology("the IT team", [term("IT", "信息技术")])).toBe("the 信息技术 team");
    expect(applyTerminology("the figma file", [term("Figma", "菲格玛")])).toBe(
      "the figma file"
    );
  });

  it("does not rewrite a term that is only part of another word", () => {
    expect(applyTerminology("He said it plainly.", [term("AI", "人工智能")])).toBe(
      "He said it plainly."
    );
  });

  it("renders a term in a script that is written without spaces", () => {
    expect(applyTerminology("悟空来了。", [term("悟空", "Goku", "name")])).toBe("Goku来了。");
  });

  it("renders a term written with dollar signs exactly as the user wrote it", () => {
    // `$&` and friends are replacement patterns to String.replace. A price or
    // a variable name in a glossary must reach the caption as typed.
    expect(applyTerminology("the cost field", [term("cost", "$$")])).toBe("the $$ field");
    expect(applyTerminology("the cost field", [term("cost", "$&")])).toBe("the $& field");
  });

  it("leaves the translation alone when there is nothing to fix", () => {
    expect(applyTerminology("早上好。", [])).toBe("早上好。");
    expect(applyTerminology("早上好。", [term("Figma", "Figma")])).toBe("早上好。");
    expect(applyTerminology("早上好。", [term("  ", "空")])).toBe("早上好。");
  });
});

describe("what one request may be told about a term", () => {
  it("keeps the user's rendering when the call registers the same name", () => {
    // The meeting registers Alice's display name as itself so the model keeps
    // it stable. The user already said how it reads, and telling the model
    // both would be telling it nothing.
    const merged = mergeTerminology(
      [term("Alice Chen", "陈爱丽", "name")],
      [term("Alice Chen", "Alice Chen", "name")]
    );

    expect(merged).toEqual([term("Alice Chen", "陈爱丽", "name")]);
  });

  it("matches the user's term however it was capitalised or spaced", () => {
    const merged = mergeTerminology(
      [term("Figma", "Figma 设计稿")],
      [term("  figma  ", "figma")]
    );

    expect(merged).toEqual([term("Figma", "Figma 设计稿")]);
  });

  it("keeps a name the user never listed", () => {
    const merged = mergeTerminology(
      [term("Alice Chen", "陈爱丽", "name")],
      [term("Bob Tan", "Bob Tan", "name")]
    );

    expect(merged).toEqual([
      term("Alice Chen", "陈爱丽", "name"),
      term("Bob Tan", "Bob Tan", "name")
    ]);
  });
});
