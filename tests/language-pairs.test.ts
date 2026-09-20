import { afterEach, describe, expect, it, vi } from "vitest";
import { translateDraft } from "../src/background/draft-translator";
import { toLibreTranslateLang } from "../src/background/local-mt";
import {
  LANGUAGE_TAGS,
  normalizeLanguagePair,
  normalizeLanguageTag,
  toDeepLSource,
  toDeepLTarget
} from "../src/shared/language";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/shared/settings";
import { chooseSubtitleTrack } from "../src/shared/subtitle";

function trackList(tracks: Array<{ kind: string; language: string; label: string }>): TextTrackList {
  return Object.assign({ length: tracks.length }, tracks) as unknown as TextTrackList;
}

describe("language pair normalization", () => {
  it("offers the three meeting languages in both directions", () => {
    expect([...LANGUAGE_TAGS]).toEqual(["ja", "en", "zh-CN"]);
  });

  it("falls back to the default for a tag it does not know", () => {
    expect(normalizeLanguageTag("kl", "ja")).toBe("ja");
    expect(normalizeLanguageTag(undefined, "zh-CN")).toBe("zh-CN");
    expect(normalizeLanguageTag("en", "ja")).toBe("en");
  });

  it("keeps a chosen pair untouched", () => {
    expect(normalizeLanguagePair("en", "ja")).toEqual({ source: "en", target: "ja" });
    expect(normalizeLanguagePair("zh-CN", "ja")).toEqual({ source: "zh-CN", target: "ja" });
  });

  it("repairs a pair that would ask for a translation into its own language", () => {
    // Two independent selects can land on the same language; translating a
    // line into the language it is already in is not a usable request.
    expect(normalizeLanguagePair("en", "en")).toEqual({ source: "en", target: "zh-CN" });
    expect(normalizeLanguagePair("ja", "ja")).toEqual({ source: "ja", target: "zh-CN" });
    expect(normalizeLanguagePair("zh-CN", "zh-CN")).toEqual({ source: "zh-CN", target: "en" });
  });

  it("stores a three-way pair instead of forcing Simplified Chinese", () => {
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      sourceLanguage: "zh-CN",
      targetLanguage: "en"
    });

    expect(settings.sourceLanguage).toBe("zh-CN");
    expect(settings.targetLanguage).toBe("en");
  });

  it("still defaults to Japanese into Simplified Chinese", () => {
    const settings = normalizeSettings({});

    expect(settings.sourceLanguage).toBe("ja");
    expect(settings.targetLanguage).toBe("zh-CN");
  });

  it("repairs a stored pair that no longer makes sense", () => {
    const settings = normalizeSettings({ sourceLanguage: "en", targetLanguage: "en" });

    expect(settings.sourceLanguage).toBe("en");
    expect(settings.targetLanguage).toBe("zh-CN");
  });
});

describe("provider language codes", () => {
  it("maps every tag to the codes DeepL expects", () => {
    expect(toDeepLSource("ja")).toBe("JA");
    expect(toDeepLSource("en")).toBe("EN");
    expect(toDeepLSource("zh-CN")).toBe("ZH");
    // DeepL splits its target list into regional variants.
    expect(toDeepLTarget("zh-CN")).toBe("ZH-HANS");
    expect(toDeepLTarget("en")).toBe("EN-US");
    expect(toDeepLTarget("ja")).toBe("JA");
  });

  it("maps every tag to a base code LibreTranslate accepts", () => {
    expect(toLibreTranslateLang("ja")).toBe("ja");
    expect(toLibreTranslateLang("en")).toBe("en");
    expect(toLibreTranslateLang("zh-CN")).toBe("zh");
  });
});

describe("subtitle track selection", () => {
  it("picks the track matching the configured source language", () => {
    const tracks = trackList([
      { kind: "subtitles", language: "en", label: "English" },
      { kind: "subtitles", language: "zh-Hans", label: "中文（简体）" },
      { kind: "subtitles", language: "ja", label: "日本語" }
    ]);

    expect(chooseSubtitleTrack(tracks, "zh-CN")?.label).toBe("中文（简体）");
    expect(chooseSubtitleTrack(tracks, "ja")?.label).toBe("日本語");
    expect(chooseSubtitleTrack(tracks, "en")?.label).toBe("English");
  });

  it("does not match a language code hidden inside another word", () => {
    // "en" lives inside "auto-generated" and inside "french". A page that
    // lists those first would otherwise hand the viewer Japanese captions
    // under an English-to-Chinese translation.
    const tracks = trackList([
      { kind: "subtitles", language: "ja", label: "Japanese (auto-generated)" },
      { kind: "subtitles", language: "fr", label: "French" },
      { kind: "subtitles", language: "en", label: "English" }
    ]);

    expect(chooseSubtitleTrack(tracks, "en")?.label).toBe("English");
    expect(chooseSubtitleTrack(tracks, "ja")?.label).toBe("Japanese (auto-generated)");
  });

  it("reads the language off a label when the track carries no subtag", () => {
    const tracks = trackList([
      { kind: "subtitles", language: "", label: "Deutsch" },
      { kind: "subtitles", language: "", label: "日本語" }
    ]);

    expect(chooseSubtitleTrack(tracks, "ja")?.label).toBe("日本語");
  });

  it("falls back to the only track a page offers", () => {
    // Plenty of sites ship one track with no usable language metadata. It is
    // the subtitles the viewer can see, so it is the ones we read.
    const unlabelled = trackList([{ kind: "subtitles", language: "", label: "Subtitles" }]);

    expect(chooseSubtitleTrack(unlabelled, "en")?.label).toBe("Subtitles");
  });
});

describe("DeepL requests follow the configured pair", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks DeepL for the target the user actually chose", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ translations: [{ text: "おはようございます。" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const draft = await translateDraft({
      text: "Good morning.",
      settings: {
        ...DEFAULT_SETTINGS,
        sourceLanguage: "en",
        targetLanguage: "ja",
        draftCaptions: true,
        draftProvider: "deepl",
        draftApiKey: "draft-key"
      }
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      text: ["Good morning."],
      source_lang: "EN",
      target_lang: "JA"
    });
    expect(draft).toBe("おはようございます。");
  });
});
