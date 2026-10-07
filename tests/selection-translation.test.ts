import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionMessage, TextsTranslationResponse } from "../src/shared/messages";
import {
  normalizeSelectedText,
  splitParagraphs,
  translateSelectedText
} from "../src/shared/selection-translation";
import { DEFAULT_SETTINGS, publicSettings } from "../src/shared/settings";
import { OnDeviceTranslatorPool } from "../src/shared/translator-api";

const ON_DEVICE = publicSettings({ ...DEFAULT_SETTINGS, pageTranslateChannel: "browser" });
const DEEPL = publicSettings({
  ...DEFAULT_SETTINGS,
  pageTranslateChannel: "fast-mt",
  draftProvider: "deepl",
  draftApiKey: "key"
});

/** Chrome's Translator API as a site sees it before its first click. */
function stubTranslator(options: { availability?: string } = {}) {
  let activated = false;
  const created: string[] = [];
  vi.stubGlobal("Translator", {
    availability: async () => options.availability ?? "downloadable",
    create: async ({ sourceLanguage, targetLanguage }: { sourceLanguage: string; targetLanguage: string }) => {
      if (!activated) {
        throw Object.assign(new Error("Requires a user gesture."), { name: "NotAllowedError" });
      }
      created.push(`${sourceLanguage}>${targetLanguage}`);
      return { translate: async (text: string) => `[${targetLanguage}] ${text}` };
    }
  });
  return {
    click: () => {
      activated = true;
    },
    created
  };
}

describe("translating what the user selected", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps paragraphs and drops the page's layout whitespace", () => {
    expect(normalizeSelectedText("  第一段の\t文章 \r\n\r\n\r\n  第二段  ")).toBe("第一段の 文章\n\n第二段");
    expect(splitParagraphs("一\n\n二\n三")).toEqual(["一", "二", "三"]);
    expect(splitParagraphs(Array.from({ length: 120 }, (_, index) => `p${index}`).join("\n"))).toHaveLength(40);
  });

  it("sends the paragraphs as one request and puts each translation on its own line", async () => {
    const sent: ExtensionMessage[] = [];
    const result = await translateSelectedText("第一段\n第二段", "ja", DEEPL, {
      pool: () => {
        throw new Error("the on-device model is not used for DeepL");
      },
      send: async (message) => {
        sent.push(message);
        return { ok: true, texts: ["第一段（译）", null] } satisfies TextsTranslationResponse;
      }
    });

    expect(sent).toEqual([
      { type: "TRANSLATE_TEXTS", texts: ["第一段", "第二段"], source: "ja", markup: false }
    ]);
    // A paragraph the service could not translate is shown as it was, not dropped.
    expect(result).toEqual({ ok: true, text: "第一段（译）\n第二段", engineLabel: "DeepL" });
  });

  it("reports the channel's own error instead of an empty translation", async () => {
    const result = await translateSelectedText("こんにちは", "ja", DEEPL, {
      pool: () => new OnDeviceTranslatorPool("zh-CN"),
      send: async () => ({ ok: false, error: "DeepL 字符额度已用完（HTTP 456）。" })
    });

    expect(result).toEqual({ ok: false, error: "DeepL 字符额度已用完（HTTP 456）。" });
  });

  it("asks for one click when Chrome needs it, and translates once the click comes", async () => {
    const translator = stubTranslator();
    const pool = new OnDeviceTranslatorPool("zh-CN");
    const deps = { pool: () => pool, send: async () => undefined };

    const before = await translateSelectedText("こんにちは", "ja", ON_DEVICE, deps);
    expect(before).toMatchObject({ ok: false, needsActivation: true });
    expect(pool.needsActivation()).toBe(true);

    translator.click();
    expect(await pool.activate()).toBe(true);
    const after = await translateSelectedText("こんにちは", "ja", ON_DEVICE, deps);

    expect(after).toEqual({ ok: true, text: "[zh] こんにちは", engineLabel: "Chrome 本地翻译" });
    expect(translator.created).toEqual(["ja>zh"]);
  });

  it("says when this Chrome cannot translate on the device and points at the setting", async () => {
    stubTranslator({ availability: "unavailable" });
    const result = await translateSelectedText("こんにちは", "ja", ON_DEVICE, {
      pool: () => new OnDeviceTranslatorPool("zh-CN"),
      send: async () => undefined
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain("网页翻译通道");
  });

  it("translates nothing while the extension is paused", async () => {
    const send = vi.fn();
    const result = await translateSelectedText("こんにちは", "ja", { ...DEEPL, enabled: false }, {
      pool: () => new OnDeviceTranslatorPool("zh-CN"),
      send
    });

    expect(result).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
  });
});
