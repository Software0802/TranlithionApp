/**
 * The language pairs the extension can translate between.
 *
 * V1 shipped one direction (ja → zh-CN) with the target hard-coded. Meeting
 * captions are routinely English or Chinese, so source and target are now the
 * same three-value set and either side is user-selectable.
 */
export const LANGUAGE_TAGS = ["ja", "en", "zh-CN"] as const;

export type LanguageTag = (typeof LANGUAGE_TAGS)[number];

interface LanguageDescriptor {
  /** Shown in the options page, in the user's own script. */
  label: string;
  /** Used inside the translation prompt, which is written in English. */
  english: string;
  /** DeepL source code. */
  deepLSource: string;
  /** DeepL target code; DeepL splits Chinese and English into variants. */
  deepLTarget: string;
  /** Base BCP-47 tag for APIs that reject regional subtags. */
  short: string;
  /** Substrings that identify this language in a TextTrack label. */
  trackMatchers: readonly string[];
  /** Sample line the options page sends when testing the connection. */
  sample: string;
}

const LANGUAGES: Record<LanguageTag, LanguageDescriptor> = {
  ja: {
    label: "日语",
    english: "Japanese",
    deepLSource: "JA",
    deepLTarget: "JA",
    short: "ja",
    trackMatchers: ["ja", "jpn", "japanese", "日本"],
    sample: "こんにちは"
  },
  en: {
    label: "英语",
    english: "English",
    deepLSource: "EN",
    deepLTarget: "EN-US",
    short: "en",
    trackMatchers: ["en", "eng", "english"],
    sample: "Good morning."
  },
  "zh-CN": {
    label: "简体中文",
    english: "Simplified Chinese",
    deepLSource: "ZH",
    deepLTarget: "ZH-HANS",
    short: "zh",
    trackMatchers: ["zh", "chi", "zho", "chinese", "中文", "简体"],
    sample: "早上好。"
  }
};

export function isLanguageTag(value: unknown): value is LanguageTag {
  return typeof value === "string" && (LANGUAGE_TAGS as readonly string[]).includes(value);
}

export function normalizeLanguageTag(value: unknown, fallback: LanguageTag): LanguageTag {
  return isLanguageTag(value) ? value : fallback;
}

export function languageLabel(tag: LanguageTag): string {
  return LANGUAGES[tag].label;
}

export function languageEnglishName(tag: LanguageTag): string {
  return LANGUAGES[tag].english;
}

/** "日语 → 简体中文", for headers and status copy. */
export function languagePairLabel(source: LanguageTag, target: LanguageTag): string {
  return `${languageLabel(source)} → ${languageLabel(target)}`;
}

/** DeepL expects upper-case codes and distinguishes source from target variants. */
export function toDeepLSource(tag: LanguageTag): string {
  return LANGUAGES[tag].deepLSource;
}

export function toDeepLTarget(tag: LanguageTag): string {
  return LANGUAGES[tag].deepLTarget;
}

/** LibreTranslate and Chrome's Translator API both reject `zh-CN`. */
export function toShortLanguageCode(tag: LanguageTag): string {
  return LANGUAGES[tag].short;
}

export function trackLanguageMatchers(tag: LanguageTag): readonly string[] {
  return LANGUAGES[tag].trackMatchers;
}

/** A short line in the source language, used by the options page test button. */
export function sampleSourceText(tag: LanguageTag): string {
  return LANGUAGES[tag].sample;
}

/**
 * Keeps the pair translatable. Source and target come from two independent
 * selects, so a user switching the target to the language they are already
 * reading would otherwise ask every provider to translate a line into itself.
 */
export function normalizeLanguagePair(
  source: LanguageTag,
  target: LanguageTag
): { source: LanguageTag; target: LanguageTag } {
  if (source !== target) {
    return { source, target };
  }
  // A Chinese source is being read by someone who wants another language;
  // everything else defaults back to the Chinese the extension was built for.
  return { source, target: source === "zh-CN" ? "en" : "zh-CN" };
}
