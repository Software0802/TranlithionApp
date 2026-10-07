import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageChannelError, type PageChannel } from "../src/content/page/channels";
import { PageTranslator, type PageTranslationView } from "../src/content/page/page-translator";
import type { LanguageTag } from "../src/shared/language";
import { DEFAULT_SETTINGS, publicSettings } from "../src/shared/settings";
import type { PublicTranslationSettings } from "../src/shared/types";
import {
  asElement,
  dataWrites,
  h,
  installFakePage,
  mutate,
  text,
  type FakeElement,
  type FakeNode,
  type Placement
} from "./helpers/fake-page";

/**
 * Drives the real page translator over a fake page whose structural methods
 * throw unless the page itself calls them: every test here would fail if the
 * translator ever inserted, moved or removed a node.
 */

interface HeldRequest {
  texts: string[];
  source: LanguageTag;
  markup: boolean;
  settled: boolean;
  answer: (translations: Array<string | null>) => Promise<void>;
  fail: (error: Error) => Promise<void>;
}

const SETTINGS: PublicTranslationSettings = publicSettings({
  ...DEFAULT_SETTINGS,
  targetLanguage: "zh-CN"
});

function heldChannel(options: { markup?: boolean; items?: number } = {}) {
  const requests: HeldRequest[] = [];
  let activations = 0;
  const channel: PageChannel = {
    engine: options.markup ? "deepl" : "libretranslate",
    markup: options.markup ?? false,
    limits: { items: options.items ?? 10, chars: 4_000, concurrency: 2 },
    translate(texts, source, markup) {
      return new Promise((resolve, reject) => {
        const request: HeldRequest = {
          texts,
          source,
          markup,
          settled: false,
          answer: async (translations) => {
            request.settled = true;
            resolve(translations);
            await vi.advanceTimersByTimeAsync(0);
          },
          fail: async (error) => {
            request.settled = true;
            reject(error);
            await vi.advanceTimersByTimeAsync(0);
          }
        };
        requests.push(request);
      });
    },
    activate: async () => {
      activations += 1;
      return true;
    },
    destroy: () => undefined
  };
  return { channel, requests, activations: () => activations };
}

function start(
  body: FakeElement,
  options: {
    lang?: string;
    markup?: boolean;
    items?: number;
    settings?: PublicTranslationSettings;
  } = {}
) {
  const page = installFakePage(body, { lang: options.lang });
  vi.stubGlobal("MutationObserver", page.globals.MutationObserver);
  vi.stubGlobal("IntersectionObserver", page.globals.IntersectionObserver);
  vi.stubGlobal("window", page.globals.window);
  const held = heldChannel(options);
  const views: PageTranslationView[] = [];
  let created = 0;
  const translator = new PageTranslator(options.settings ?? SETTINGS, {
    root: () => asElement(body),
    langAttribute: () => page.html.getAttribute("lang"),
    createChannel: () => {
      created += 1;
      return held.channel;
    },
    onChange: (view) => views.push(view)
  });
  translator.start();
  return {
    ...held,
    page,
    translator,
    views,
    created: () => created,
    lastView: () => views[views.length - 1],
    /** Lets the translator read the page, then reports where everything is. */
    async read(place: (element: FakeElement) => Placement | null = () => ({ top: 100 })) {
      await vi.advanceTimersByTimeAsync(0);
      page.intersection.notice(place);
      await vi.advanceTimersByTimeAsync(0);
    }
  };
}

function sameNodes(before: FakeNode[], after: FakeNode[]): boolean {
  return before.length === after.length && before.every((node, index) => node === after[index]);
}

describe("one-click page translation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("translates what is near the screen in place and leaves the page's nodes where they were", async () => {
    const near = h("p", {}, "こんにちは世界");
    const far = h("p", {}, "さようなら");
    const body = h("body", {}, near, far);
    const shape = body.shape();
    const run = start(body);

    await run.read((element) => (element === near ? { top: 120 } : null));

    expect(run.requests.map((request) => request.texts)).toEqual([["こんにちは世界"]]);
    await run.requests[0].answer(["你好，世界"]);
    expect(near.texts()[0].data).toBe("你好，世界");
    expect(far.texts()[0].data).toBe("さようなら");
    expect(sameNodes(shape, body.shape())).toBe(true);
    expect(run.lastView()).toMatchObject({ phase: "settled", translated: 1 });

    // The rest arrives as the reader scrolls towards it.
    run.page.intersection.move([far], () => ({ top: 900 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(run.requests[1].texts).toEqual(["さようなら"]);
  });

  it("translates a sentence split by a link as one sentence and keeps the link's own text node", async () => {
    const link = h("a", { href: "/help" }, "こちら");
    const body = h("body", {}, h("p", {}, "詳しくは", link, "をご覧ください"));
    const linkText = link.texts()[0];
    const run = start(body, { markup: true });

    await run.read();

    expect(run.requests[0]).toMatchObject({
      texts: ["詳しくは<t0>こちら</t0>をご覧ください"],
      markup: true
    });
    await run.requests[0].answer(["详情请看<t0>这里</t0>。"]);
    expect(body.texts().map((node) => node.data)).toEqual(["详情请看", "这里", "。"]);
    expect(link.texts()[0]).toBe(linkText);
  });

  it("falls back to stretch-by-stretch when the translation loses a tag", async () => {
    const body = h("body", {}, h("p", {}, "詳しくは", h("a", {}, "こちら"), "をご覧ください"));
    const run = start(body, { markup: true });

    await run.read();
    await run.requests[0].answer(["详情请看这里"]);

    expect(run.requests[1]).toMatchObject({
      texts: ["詳しくは", "こちら", "をご覧ください"],
      markup: false
    });
    await run.requests[1].answer(["详情", "这里", "请看"]);
    expect(body.texts().map((node) => node.data)).toEqual(["详情", "这里", "请看"]);
  });

  it("puts React-style adjacent text nodes back as one translation without removing any", async () => {
    const parts = [text("Hello "), text("Alice"), text("!")];
    const body = h("body", {}, h("p", {}, ...parts));
    const run = start(body);

    await run.read();

    expect(run.requests[0].texts).toEqual(["Hello Alice!"]);
    await run.requests[0].answer(["你好，爱丽丝！"]);
    expect(parts.map((part) => part.data)).toEqual(["你好，爱丽丝！", "", ""]);
    expect(parts.every((part) => part.isConnected)).toBe(true);
  });

  it("restores the original text, except where the page has written its own since", async () => {
    const title = h("h1", {}, "お知らせ");
    const counter = h("p", {}, "残り時間です");
    const body = h("body", {}, title, counter);
    const run = start(body);
    await run.read();
    await run.requests[0].answer(["通知", "剩余时间"]);

    // The page updates its counter and the reader restores in the same task,
    // before the translator has seen the change.
    mutate(() => {
      counter.texts()[0].data = "残り 3 分";
    });
    expect(run.translator.restore().restored).toBe(1);

    expect(title.texts()[0].data).toBe("お知らせ");
    expect(counter.texts()[0].data).toBe("残り 3 分");
    expect(run.lastView().phase).toBe("idle");
  });

  it("re-applies a translation from cache when the page re-renders the same text, without a request", async () => {
    const label = h("button", {}, "保存する");
    const body = h("body", {}, label);
    const run = start(body);
    await run.read();
    await run.requests[0].answer(["保存"]);

    mutate(() => {
      label.texts()[0].data = "保存する";
    });
    // The mutation observer runs in the microtask after the page's change,
    // before the browser paints: the original never reaches the screen.
    await Promise.resolve();
    await Promise.resolve();

    expect(label.texts()[0].data).toBe("保存");
    expect(run.requests).toHaveLength(1);
  });

  it("translates the page's new text and never writes a stale answer over it", async () => {
    const status = h("p", {}, "読み込み中");
    const body = h("body", {}, status);
    const run = start(body);
    await run.read();

    mutate(() => {
      status.texts()[0].data = "完了しました";
    });
    await vi.advanceTimersByTimeAsync(0);
    await run.requests[0].answer(["加载中"]);

    expect(status.texts()[0].data).toBe("完了しました");
    expect(run.requests[1].texts).toEqual(["完了しました"]);
    await run.requests[1].answer(["已完成"]);
    expect(status.texts()[0].data).toBe("已完成");
  });

  it("keeps a sentence with a live counter translated, word by word around the number", async () => {
    const count = text("3");
    const parts = [text("新着メッセージが "), count, text(" 件あります")];
    const body = h("body", {}, h("p", {}, ...parts));
    const run = start(body);
    await run.read();
    expect(run.requests[0].texts).toEqual(["新着メッセージが 3 件あります"]);
    await run.requests[0].answer(["有 3 条新消息"]);

    // Each tick rewrites the whole translated sentence at first…
    for (let tick = 4; tick <= 10; tick += 1) {
      mutate(() => {
        count.data = String(tick);
      });
      await vi.advanceTimersByTimeAsync(0);
    }
    // …so the sentence is read again node by node, leaving the number alone.
    for (const request of run.requests.filter((request) => !request.settled)) {
      if (!request.texts.includes("新着メッセージが")) {
        await request.answer(request.texts.map(() => "（过时）"));
      }
    }
    const byNode = run.requests.find((request) => request.texts.includes("新着メッセージが"));
    expect(byNode?.texts).toEqual(["新着メッセージが", "件あります"]);
    await byNode?.answer(["新消息", "条"]);
    // Ticks queued behind a busy channel were dropped rather than sent.
    expect(run.requests.length).toBeLessThanOrEqual(5);

    const asked = run.requests.length;
    for (let tick = 11; tick <= 40; tick += 1) {
      mutate(() => {
        count.data = String(tick);
      });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(parts.map((part) => part.data)).toEqual(["新消息 ", "40", " 条"]);
    expect(run.requests).toHaveLength(asked);
  });

  it("stops fighting over text the page keeps rewriting", async () => {
    const ticker = h("span", {}, "更新しています");
    const body = h("body", {}, h("p", {}, ticker));
    const run = start(body);
    await run.read();
    await run.requests[0].answer(["正在更新"]);

    // Rewritten 6 times it is re-applied; then it is read node by node and
    // re-applied 6 times more; after that it is left in the original.
    for (let rewrite = 1; rewrite <= 14; rewrite += 1) {
      mutate(() => {
        ticker.texts()[0].data = "更新しています";
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(ticker.texts()[0].data).toBe(rewrite <= 13 ? "正在更新" : "更新しています");
    }

    const translatorWrites = dataWrites.filter((write) => !write.byPage);
    mutate(() => {
      ticker.texts()[0].data = "更新しています";
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(dataWrites.filter((write) => !write.byPage)).toHaveLength(translatorWrites.length);
  });

  it("sends each distinct string once and reads each string's own language", async () => {
    const body = h(
      "body",
      {},
      h("p", {}, "お問い合わせ"),
      h("p", {}, "お問い合わせ"),
      h("button", {}, "Sign in"),
      h("p", {}, "会社概要"),
      h("p", {}, "2026/09/30")
    );
    const run = start(body, { lang: "ja" });

    await run.read();

    const bySource = Object.fromEntries(run.requests.map((request) => [request.source, request.texts]));
    expect(bySource).toEqual({ ja: ["お問い合わせ", "会社概要"], en: ["Sign in"] });
    await run.requests.find((request) => request.source === "ja")?.answer(["联系我们", "公司简介"]);
    expect(body.texts().map((node) => node.data).slice(0, 2)).toEqual(["联系我们", "联系我们"]);
  });

  it("leaves text that is already in the target language alone", async () => {
    const body = h("body", {}, h("p", {}, "这是简体中文的正文内容。"));
    const run = start(body, { lang: "zh-CN" });

    await run.read();

    expect(run.requests).toHaveLength(0);
    expect(run.lastView()).toMatchObject({ phase: "settled" });
    expect(run.lastView().message).toContain("没有需要翻译");
  });

  it("waits for one click when Chrome needs it, then carries on with the same strings", async () => {
    const body = h("body", {}, h("p", {}, "こんにちは"));
    const run = start(body);
    await run.read();

    await run.requests[0].fail(
      new PageChannelError("Chrome 需要你在页面上点一下。", "needs-activation")
    );
    expect(run.lastView()).toMatchObject({ phase: "needs-activation" });

    await run.translator.activate();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.activations()).toBe(1);
    expect(run.requests[1].texts).toEqual(["こんにちは"]);
    await run.requests[1].answer(["你好"]);
    expect(body.texts()[0].data).toBe("你好");
  });

  it("says why when the channel cannot translate, and asks it for nothing more", async () => {
    const body = h("body", {}, h("p", {}, "こんにちは"));
    const run = start(body);
    await run.read();

    await run.requests[0].fail(new PageChannelError("DeepL 字符额度已用完。", "fatal"));
    expect(run.lastView()).toMatchObject({ phase: "error", message: "DeepL 字符额度已用完。" });

    mutate(() => {
      body.appendChild(h("p", {}, "新しい段落"));
    });
    await vi.advanceTimersByTimeAsync(200);
    run.page.intersection.notice(() => ({ top: 300 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(run.requests).toHaveLength(1);
  });

  it("picks up content the page adds after it was translated", async () => {
    const body = h("body", {}, h("p", {}, "一件目"));
    const run = start(body, { lang: "ja" });
    await run.read();
    await run.requests[0].answer(["第一条"]);

    const added = h("li", {}, "二件目");
    mutate(() => {
      body.appendChild(h("ul", {}, added));
    });
    await vi.advanceTimersByTimeAsync(200);
    run.page.intersection.notice(() => ({ top: 400 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(run.requests[1].texts).toEqual(["二件目"]);
    await run.requests[1].answer(["第二条"]);
    expect(added.texts()[0].data).toBe("第二条");
  });

  it("translates the page again when the target language changes", async () => {
    const paragraph = h("p", {}, "ありがとう");
    const body = h("body", {}, paragraph);
    const run = start(body);
    await run.read();
    await run.requests[0].answer(["谢谢"]);

    run.translator.updateSettings({ ...SETTINGS, targetLanguage: "en" });
    expect(paragraph.texts()[0].data).toBe("ありがとう");
    await run.read();

    expect(run.created()).toBe(2);
    expect(run.requests[1]).toMatchObject({ texts: ["ありがとう"], source: "ja" });
    await run.requests[1].answer(["Thank you"]);
    expect(paragraph.texts()[0].data).toBe("Thank you");
  });

  it("puts the page back when translation is paused", async () => {
    const paragraph = h("p", {}, "ありがとう");
    const run = start(h("body", {}, paragraph));
    await run.read();
    await run.requests[0].answer(["谢谢"]);

    run.translator.updateSettings({ ...SETTINGS, enabled: false });

    expect(paragraph.texts()[0].data).toBe("ありがとう");
    expect(run.translator.isActive()).toBe(false);
  });

  it("translates what is on screen before what has scrolled away", async () => {
    const top = h("p", {}, "上の段落");
    const bottom = h("p", {}, "下の段落");
    const body = h("body", {}, top, bottom);
    const run = start(body, { items: 1 });
    // Both start near the screen; only one request fits at a time per slot.
    await run.read((element) => (element === top ? { top: 0 } : { top: 1_000 }));
    expect(run.requests.map((request) => request.texts)).toEqual([["上の段落"], ["下の段落"]]);
  });
});
