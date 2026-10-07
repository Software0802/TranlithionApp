import { describe, expect, it } from "vitest";
import {
  detectTextLanguage,
  emptyScriptTally,
  pageEngineSupportsMarkup,
  pageLanguageContext,
  pageTextDestination,
  resolvePageEngine,
  tallyScripts
} from "../src/shared/page-translation";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/shared/settings";

const JAPANESE_PAGE = { hanLanguage: "ja" as const, latinIsEnglish: true };
const CHINESE_PAGE = { hanLanguage: "zh-CN" as const, latinIsEnglish: true };

describe("page text language detection", () => {
  it("reads kana as Japanese and Latin words as English", () => {
    expect(detectTextLanguage("ログインしてください", CHINESE_PAGE)).toBe("ja");
    expect(detectTextLanguage("Sign in to continue", JAPANESE_PAGE)).toBe("en");
  });

  it("lets the page decide what bare Han characters are", () => {
    // 会社概要 is Japanese on a Japanese site and would read as Chinese on a Chinese one.
    expect(detectTextLanguage("会社概要", JAPANESE_PAGE)).toBe("ja");
    expect(detectTextLanguage("公司简介", CHINESE_PAGE)).toBe("zh-CN");
  });

  it("reads text by the script most of it is written in", () => {
    expect(detectTextLanguage("Second item in the list（新規）", JAPANESE_PAGE)).toBe("en");
    expect(detectTextLanguage("iPhone 15 这个价格很合适", JAPANESE_PAGE)).toBe("zh-CN");
    // Kana settles it however much English is around it.
    expect(detectTextLanguage("Bob から新着メッセージ via Slack integration", CHINESE_PAGE)).toBe("ja");
  });

  it("tells Chinese from Japanese by the forms only one of them writes", () => {
    // A Chinese paragraph on a Japanese page, and a Japanese sign on a Chinese one.
    expect(detectTextLanguage("这是一段中文，不需要翻译。", JAPANESE_PAGE)).toBe("zh-CN");
    expect(detectTextLanguage("東京駅", CHINESE_PAGE)).toBe("ja");
    expect(detectTextLanguage("図書館", CHINESE_PAGE)).toBe("ja");
    // Characters both languages write leave it to the page.
    expect(detectTextLanguage("会社概要", CHINESE_PAGE)).toBe("zh-CN");
    expect(detectTextLanguage("会社概要", JAPANESE_PAGE)).toBe("ja");
  });

  it("finds nothing to translate in numbers, symbols, Hangul or non-English Latin pages", () => {
    expect(detectTextLanguage("2026/09/30 ¥1,200", JAPANESE_PAGE)).toBeNull();
    expect(detectTextLanguage("→ ©", JAPANESE_PAGE)).toBeNull();
    expect(detectTextLanguage("안녕하세요", JAPANESE_PAGE)).toBeNull();
    expect(detectTextLanguage("Bonjour à tous", { hanLanguage: "ja", latinIsEnglish: false })).toBeNull();
    // An English brand inside Russian text does not make the text English.
    expect(detectTextLanguage("Купить iPhone сегодня", JAPANESE_PAGE)).toBeNull();
  });

  it("judges bare Han text from the page's own kana ratio over its lang attribute", () => {
    const japanese = emptyScriptTally();
    tallyScripts(japanese, "日本語のページです。会社概要とお問い合わせはこちらからご覧いただけます。".repeat(2));
    // Templates often leave lang="en" on sites in another language.
    expect(pageLanguageContext({ langAttribute: "en", tally: japanese }).hanLanguage).toBe("ja");

    const chinese = emptyScriptTally();
    tallyScripts(chinese, "这是一个中文页面，公司简介和联系方式都在这里可以找到相关的信息内容。".repeat(2));
    expect(pageLanguageContext({ langAttribute: "ja", tally: chinese }).hanLanguage).toBe("zh-CN");

    const empty = emptyScriptTally();
    expect(pageLanguageContext({ langAttribute: "ja-JP", tally: empty }).hanLanguage).toBe("ja");
    expect(pageLanguageContext({ langAttribute: null, tally: empty }).hanLanguage).toBe("zh-CN");
    expect(pageLanguageContext({ langAttribute: "fr", tally: empty }).latinIsEnglish).toBe(false);
    expect(pageLanguageContext({ langAttribute: "en-GB", tally: empty }).latinIsEnglish).toBe(true);
  });
});

describe("page translation channel", () => {
  it("keeps page text on the device unless the user picks another channel", () => {
    expect(DEFAULT_SETTINGS.pageTranslateChannel).toBe("browser");
    expect(resolvePageEngine(DEFAULT_SETTINGS)).toBe("browser");
    expect(pageTextDestination(DEFAULT_SETTINGS)).toContain("不发送到任何服务");
  });

  it("resolves each channel to the service the user configured for it", () => {
    const base = { ...DEFAULT_SETTINGS, draftProvider: "deepl" as const, provider: "openai-compatible" as const };
    expect(resolvePageEngine({ ...base, pageTranslateChannel: "fast-mt" })).toBe("deepl");
    expect(resolvePageEngine({ ...base, pageTranslateChannel: "fast-mt", draftProvider: "browser" })).toBe("browser");
    expect(resolvePageEngine({ ...base, pageTranslateChannel: "local-mt" })).toBe("libretranslate");
    expect(resolvePageEngine({ ...base, pageTranslateChannel: "llm" })).toBe("openai-compatible");
    expect(pageEngineSupportsMarkup("deepl")).toBe(true);
    expect(pageEngineSupportsMarkup("libretranslate")).toBe(false);
  });

  it("names the host page text goes to, and only calls loopback LibreTranslate local", () => {
    expect(
      pageTextDestination({
        ...DEFAULT_SETTINGS,
        pageTranslateChannel: "fast-mt",
        draftProvider: "deepl",
        draftEndpointUrl: "https://api-free.deepl.com/v2/translate"
      })
    ).toContain("api-free.deepl.com");
    expect(
      pageTextDestination({ ...DEFAULT_SETTINGS, pageTranslateChannel: "local-mt" })
    ).toContain("不离开这台电脑");
    expect(
      pageTextDestination({
        ...DEFAULT_SETTINGS,
        pageTranslateChannel: "local-mt",
        localMtUrl: "http://192.168.1.20:5000/translate"
      })
    ).toContain("会发送到那台服务器");
    expect(
      pageTextDestination({
        ...DEFAULT_SETTINGS,
        pageTranslateChannel: "llm",
        apiBaseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat"
      })
    ).toContain("api.deepseek.com");
  });

  it("normalizes the new settings and keeps an old meeting-mascot choice", () => {
    const settings = normalizeSettings({ pageTranslateChannel: "carrier-pigeon", meetingMascot: true });

    expect(settings.pageTranslateChannel).toBe("browser");
    expect(settings.selectionToolbar).toBe(true);
    expect(settings.meetingSelectionToolbar).toBe(true);
    expect(normalizeSettings({}).meetingSelectionToolbar).toBe(false);
    expect(normalizeSettings({ pageTranslateChannel: "local-mt", selectionToolbar: false })).toMatchObject({
      pageTranslateChannel: "local-mt",
      selectionToolbar: false
    });
  });
});
