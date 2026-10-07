import { describe, expect, it } from "vitest";
import {
  layoutOf,
  parseMarkup,
  placeSlotTexts,
  serializeMarkup,
  unescapeMarkupText,
  type UnitToken
} from "../src/content/page/markup";

type Node = string;

/** `詳しくは<a>こちら</a>をご覧ください` as the segmenter reads it. */
const LINK_SENTENCE: UnitToken<Node>[] = [
  { kind: "text", nodes: ["t1"], text: "詳しくは" },
  { kind: "open", id: 0 },
  { kind: "text", nodes: ["t2"], text: "こちら" },
  { kind: "close", id: 0 },
  { kind: "text", nodes: ["t3"], text: "をご覧ください" }
];

describe("placeholder markup for sentences split by inline elements", () => {
  it("sends the sentence with its link as a numbered tag", () => {
    expect(serializeMarkup(LINK_SENTENCE)).toBe("詳しくは<t0>こちら</t0>をご覧ください");
  });

  it("escapes page text that looks like markup and collapses layout whitespace", () => {
    const tokens: UnitToken<Node>[] = [
      { kind: "text", nodes: ["t1"], text: "\n    a < b && c\n  " },
      { kind: "void", id: 0 },
      { kind: "text", nodes: ["t2"], text: "  done  " }
    ];

    expect(serializeMarkup(tokens)).toBe("a &lt; b &amp;&amp; c <x0/> done");
  });

  it("maps a translation that keeps the tags back onto the page's own text slots", () => {
    const layout = layoutOf(LINK_SENTENCE);
    const slots = parseMarkup("详情请看<t0>这里</t0>。", layout.tags);

    expect(slots).toEqual(["详情请看", "这里", "。"]);
    expect(layout.slots.map((slot) => slot?.nodes)).toEqual([["t1"], ["t2"], ["t3"]]);
  });

  it("refuses a translation that dropped, added or reordered a tag", () => {
    const tags = layoutOf<Node>([
      { kind: "open", id: 0 },
      { kind: "text", nodes: ["a"], text: "A" },
      { kind: "close", id: 0 },
      { kind: "text", nodes: ["b"], text: " of " },
      { kind: "open", id: 1 },
      { kind: "text", nodes: ["c"], text: "B" },
      { kind: "close", id: 1 }
    ]).tags;

    // Moving B before A would need the page's nodes to move too.
    expect(parseMarkup("<t1>B</t1>的<t0>A</t0>", tags)).toBeNull();
    expect(parseMarkup("<t0>A</t0>的B", tags)).toBeNull();
    expect(parseMarkup("<t0>A</t0>和<t1>B</t1><t2>C</t2>", tags)).toBeNull();
    expect(parseMarkup("<t0>A</t0>的<t1>B</t1>", tags)).toEqual(["", "A", "的", "B", ""]);
  });

  it("reads tags written loosely and entities the service escaped", () => {
    const tags = layoutOf(LINK_SENTENCE).tags;

    expect(parseMarkup("Details: < t0 >here< /T0 > &amp; more", tags)).toEqual([
      "Details: ",
      "here",
      " & more"
    ]);
    expect(unescapeMarkupText("&lt;b&gt; &#39;x&#x27; &quot;")).toBe("<b> 'x' \"");
  });

  it("treats a void placeholder answered with a closing half as one element", () => {
    const tags = layoutOf<Node>([
      { kind: "text", nodes: ["a"], text: "Line one" },
      { kind: "void", id: 0 },
      { kind: "text", nodes: ["b"], text: "line two" }
    ]).tags;

    expect(parseMarkup("第一行<x0></x0>第二行", tags)).toEqual(["第一行", "第二行"]);
  });

  it("moves words across an icon to a slot that can hold them, never across a link", () => {
    // `<x0/>Settings`: the page has no text node before the icon.
    const iconFirst = layoutOf<Node>([
      { kind: "void", id: 0 },
      { kind: "text", nodes: ["label"], text: "Settings" }
    ]);
    expect(placeSlotTexts(["设置", ""], [false, true], iconFirst.tags)).toEqual(["", "设置"]);

    // `<t0>Home</t0>`: words the translation put outside the link have no
    // node outside the link to go to, and must not be pulled inside it.
    const linkOnly = layoutOf<Node>([
      { kind: "open", id: 0 },
      { kind: "text", nodes: ["home"], text: "Home" },
      { kind: "close", id: 0 }
    ]);
    expect(placeSlotTexts(["返回", "主页", ""], [false, true, false], linkOnly.tags)).toBeNull();
    expect(placeSlotTexts(["", "主页", " "], [false, true, false], linkOnly.tags)).toEqual([
      "",
      "主页",
      ""
    ]);
  });
});
