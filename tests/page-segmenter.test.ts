import { describe, expect, it } from "vitest";
import { serializeMarkup } from "../src/content/page/markup";
import {
  containerOf,
  extractUnits,
  isInsideExcluded,
  TextScanner
} from "../src/content/page/segmenter";
import { asElement, h, text, type FakeElement } from "./helpers/fake-page";

function containersIn(root: FakeElement): string[] {
  const found: string[] = [];
  const scanner = new TextScanner(root as unknown as Node, (_text, container) => {
    const name = (container as unknown as FakeElement).getAttribute("id") ?? container.tagName;
    if (!found.includes(name)) {
      found.push(name);
    }
  });
  expect(scanner.step(() => false)).toBe(true);
  return found;
}

function markupOf(container: FakeElement): string[] {
  return extractUnits(asElement(container)).map((unit) => serializeMarkup(unit.tokens));
}

describe("reading a page into translation units", () => {
  it("files text inside links and bold words under the block they sit in", () => {
    const paragraph = h("p", { id: "para" }, "詳しくは", h("a", { href: "#" }, "こちら"), "をご覧ください");
    const body = h("body", {}, paragraph, h("li", { id: "item" }, h("strong", {}, "注意")));

    expect(containersIn(body)).toEqual(["para", "item"]);
    expect(containerOf(paragraph.texts()[1] as unknown as Node)).toBe(asElement(paragraph));
  });

  it("never reads code, form controls, editors, captions or opted-out text", () => {
    const body = h(
      "body",
      {},
      h("pre", { id: "pre" }, "const x = 1;"),
      h("p", { id: "code-inline" }, h("code", {}, "npm install")),
      h("textarea", { id: "draft" }, "下書き"),
      h("select", {}, h("option", {}, "東京")),
      h("div", { id: "editor", contenteditable: "true" }, h("p", {}, "編集中の文章")),
      h("div", { id: "brand", translate: "no" }, "ブランド名"),
      h("span", { id: "google-opt-out", class: "logo notranslate" }, "ロゴ"),
      h("div", { class: "ytp-caption-window-container" }, h("span", {}, "字幕")),
      h("div", { "data-uia": "player-subtitle-text" }, "ネットフリックス字幕"),
      h("script", {}, "window.x = 'テキスト'"),
      h("p", { id: "plain" }, "読める文章")
    );

    expect(containersIn(body)).toEqual(["plain"]);
    const edited = (body.childNodes[4] as FakeElement).texts()[0];
    expect(isInsideExcluded(edited as unknown as Node)).toBe(true);
  });

  it("keeps a sentence with its inline elements as one unit and splits at nested blocks", () => {
    const container = h(
      "div",
      {},
      "Intro with ",
      h("b", {}, "bold"),
      " text",
      h("p", {}, "A nested paragraph"),
      "Trailing words"
    );

    expect(markupOf(container)).toEqual(["Intro with <t0>bold</t0> text", "Trailing words"]);
  });

  it("marks icons, line breaks and inline code as positions in the sentence", () => {
    const button = h(
      "button",
      {},
      h("svg", {}, h("path", {})),
      h("i", { class: "icon" }),
      " Run ",
      h("code", {}, "npm test"),
      h("br", {}),
      "then deploy"
    );

    expect(markupOf(button)).toEqual(["<x0/><x1/> Run <x2/><x3/>then deploy"]);
  });

  it("leaves ruby readings out of the sentence they annotate", () => {
    const paragraph = h("p", {}, h("ruby", {}, "漢字", h("rt", {}, "かんじ")), "を読む");

    expect(markupOf(paragraph)).toEqual(["<t0>漢字</t0>を読む"]);
  });

  it("groups adjacent text nodes into one run, as React renders `Hello {name}!`", () => {
    const paragraph = h("p", {}, text("Hello "), text("Alice"), text("!"));
    const [unit] = extractUnits(asElement(paragraph));

    expect(unit.tokens).toHaveLength(1);
    expect(unit.tokens[0]).toMatchObject({ kind: "text", text: "Hello Alice!" });
    expect(unit.nodes.map((node) => node.data)).toEqual(["Hello ", "Alice", "!"]);
  });

  it("translates run by run when a block interrupts an inline element", () => {
    const card = h("li", {}, h("a", {}, "Title ", h("div", {}, "Body"), " more"));
    const units = extractUnits(asElement(card));

    expect(units.map((unit) => unit.plainOnly)).toEqual([true, true]);
  });

  it("walks a large page in slices when asked to yield", () => {
    const body = h(
      "body",
      {},
      ...Array.from({ length: 2_000 }, (_, index) => h("p", { id: `p${index}` }, `段落 ${index}`))
    );
    const seen: unknown[] = [];
    const scanner = new TextScanner(body as unknown as Node, (_text, container) => seen.push(container));
    let slices = 0;
    let budget = 0;
    while (!scanner.step(() => ++budget % 5 === 0)) {
      slices += 1;
    }

    expect(slices).toBeGreaterThan(1);
    expect(seen).toHaveLength(2_000);
  });
});
