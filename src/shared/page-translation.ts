import type { LanguageTag } from "./language";
import { isLoopbackUrl } from "./meeting";
import type { PageTranslateChannel, TranslationSettings } from "./types";

/**
 * Web page translation: a whole page, a selection, or text sent to the side
 * panel. Captions translate one line at a time against a timeline; a page is
 * hundreds of short strings at once, so this path batches, caches and
 * translates what is on screen first, and it picks its own channel.
 */

/** The service a page request actually lands on, once the channel is resolved. */
export type PageEngine =
  | "browser"
  | "deepl"
  | "custom"
  | "libretranslate"
  | "openai-compatible"
  | "websocket"
  | "mock";

type EngineSettings = Pick<TranslationSettings, "pageTranslateChannel" | "draftProvider" | "provider">;

export function resolvePageEngine(settings: EngineSettings): PageEngine {
  switch (settings.pageTranslateChannel) {
    case "local-mt":
      return "libretranslate";
    case "fast-mt":
      // The draft channel set to Chrome's model is the on-device channel.
      return settings.draftProvider === "browser" ? "browser" : settings.draftProvider;
    case "llm":
      return settings.provider;
    case "browser":
    default:
      return "browser";
  }
}

/**
 * Whether the engine keeps inline placeholder tags (`<t0>…</t0>`, `<x1/>`) in
 * place. Those let a sentence split by a link or a bold word be translated
 * as one sentence and still land back in the page's own text nodes.
 */
export function pageEngineSupportsMarkup(engine: PageEngine): boolean {
  return engine === "deepl" || engine === "openai-compatible";
}

export interface PageBatchLimits {
  /** Strings per request. */
  items: number;
  /** Characters per request. */
  chars: number;
  /** Requests one page keeps in flight. */
  concurrency: number;
}

/**
 * How the content script packs a page into requests. DeepL takes fifty
 * strings in one request and answers them together; a chat model writes its
 * answer token by token, so smaller batches in parallel reach the screen
 * sooner; Chrome's model and the per-string HTTP services take one string at
 * a time however they are packed.
 */
export function pageBatchLimits(engine: PageEngine): PageBatchLimits {
  switch (engine) {
    case "browser":
      return { items: 1, chars: PAGE_MAX_ITEM_CHARS, concurrency: 2 };
    case "deepl":
      return { items: 40, chars: 8_000, concurrency: 3 };
    case "openai-compatible":
      return { items: 16, chars: 1_500, concurrency: 4 };
    case "websocket":
      return { items: 4, chars: 2_000, concurrency: 2 };
    case "mock":
      return { items: 50, chars: 50_000, concurrency: 2 };
    case "custom":
    case "libretranslate":
    default:
      return { items: 10, chars: 4_000, concurrency: 2 };
  }
}

/** A string longer than this is not sent as one item. */
export const PAGE_MAX_ITEM_CHARS = 5_000;
/** One `TRANSLATE_TEXTS` message carries at most this many strings… */
export const PAGE_MAX_REQUEST_ITEMS = 50;
/** …and at most this many characters in total. */
export const PAGE_MAX_REQUEST_CHARS = 60_000;

export function pageTranslateChannelLabel(channel: PageTranslateChannel): string {
  switch (channel) {
    case "local-mt":
      return "本机 LibreTranslate";
    case "fast-mt":
      return "机器翻译通道（DeepL / 自定义）";
    case "llm":
      return "大模型主翻译服务";
    case "browser":
    default:
      return "Chrome 内置本地翻译";
  }
}

/** Short name of the service behind a result, for status lines. */
export function pageEngineLabel(engine: PageEngine): string {
  switch (engine) {
    case "deepl":
      return "DeepL";
    case "custom":
      return "自定义机器翻译";
    case "libretranslate":
      return "LibreTranslate";
    case "openai-compatible":
      return "大模型";
    case "websocket":
      return "WebSocket 服务";
    case "mock":
      return "演示翻译";
    case "browser":
    default:
      return "Chrome 本地翻译";
  }
}

type DestinationSettings = EngineSettings &
  Pick<
    TranslationSettings,
    "draftEndpointUrl" | "localMtUrl" | "apiBaseUrl" | "webSocketUrl" | "model"
  >;

/**
 * Where the text of a page the user translates is sent. A page can be the
 * user's mail or an internal document, so the options page and the popup say
 * this in words instead of leaving the user to infer it from the channel.
 */
export function pageTextDestination(settings: DestinationSettings): string {
  switch (resolvePageEngine(settings)) {
    case "libretranslate":
      // Only a loopback address is this computer; the same field accepts a
      // LAN box or a VPS, and promising the text stays here would be false.
      return isLoopbackUrl(settings.localMtUrl)
        ? `本机 LibreTranslate（${hostOf(settings.localMtUrl)}）：网页文字不离开这台电脑。`
        : `LibreTranslate（${hostOf(
            settings.localMtUrl
          )}）：该地址不在这台电脑上，网页文字会发送到那台服务器。`;
    case "deepl":
      return `DeepL（${hostOf(
        settings.draftEndpointUrl
      )}）：网页文字会发送到 DeepL，并计入你的 DeepL 字符额度。`;
    case "custom":
      return `自定义机器翻译服务（${hostOf(settings.draftEndpointUrl)}）：网页文字会发送到该服务。`;
    case "openai-compatible":
      return `大模型翻译服务 ${hostOf(settings.apiBaseUrl)} 的 ${settings.model}：网页文字会发送到该服务，按用量计费。`;
    case "websocket":
      return `自建 WebSocket 服务（${hostOf(settings.webSocketUrl)}）：网页文字会发送到该服务。`;
    case "mock":
      return "演示翻译：不联网，只给原文加上「演示翻译」标记。";
    case "browser":
    default:
      return "Chrome 内置本地翻译模型：网页文字只在这台电脑上翻译，不发送到任何服务。";
  }
}

/** The same, in a few words for the popup. */
export function pageTextDestinationShort(settings: DestinationSettings): string {
  switch (resolvePageEngine(settings)) {
    case "libretranslate":
      return isLoopbackUrl(settings.localMtUrl)
        ? "文字不离开这台电脑"
        : `文字发送到 ${hostOf(settings.localMtUrl)}`;
    case "deepl":
    case "custom":
      return `文字发送到 ${hostOf(settings.draftEndpointUrl)}`;
    case "openai-compatible":
      return `文字发送到 ${hostOf(settings.apiBaseUrl)}`;
    case "websocket":
      return `文字发送到 ${hostOf(settings.webSocketUrl)}`;
    case "mock":
      return "演示翻译，不联网";
    case "browser":
    default:
      return "文字不离开这台电脑";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/*
 * Language detection.
 *
 * Captions come in the language the user picked for the video. A page does
 * not: an English help page, a Japanese shop, a Chinese forum, and English
 * menus on a Japanese site all turn up in the same browsing session. Pages
 * therefore translate *from* whichever of the three supported languages a
 * string is written in, and *into* the configured target language.
 *
 * Scripts tell the three apart well: kana is Japanese, Hangul is not
 * supported, and Latin letters are English. Han characters without kana are
 * the one ambiguous case. Forms only one of the two languages writes settle
 * most of it (这 is Chinese, 駅 Japanese); for text with neither — 会社概要,
 * 公司简介 — the page as a whole decides. Traditional Chinese reads as
 * Chinese, so it is not converted into simplified.
 */

const KANA = /[\u3005\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/;
const KANA_ALL = /[\u3005\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9f]/g;
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const HAN_ALL = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
/**
 * Common simplified forms Japanese does not use (这 for 這, 说 for 説…): Han
 * text with these is Chinese whatever page it is on.
 */
const SIMPLIFIED_ONLY = /[这们个说时为过还对进让给从发现应问间经样东车长门马见边书买卖爱听谁吗呢吧么该实业电话题报华网务势际构类级标权线组织统计设认证显页览阅读释译办产处响员场帮请谢儿开关头语动气乐药变历总检验转战传价归单铁钱银错须顺预领飞鸟鱼岁视节广亲觉带师张]/;
/**
 * Japanese forms Chinese writes differently, simplified or traditional
 * (図 for 图/圖, 駅 for 站…): Han text with these is Japanese.
 */
const JAPANESE_ONLY = /[図気楽薬読発変対様広歴経総検験転戦伝価帰単鉄関円県済営択拠団売続雑険児労勧巻浜駅実説観権圧囲桜塩聴仮帯滝沢郷黒両満歩渋乗焼恵覚]/;
const LATIN_ALL = /[A-Za-z\u00c0-\u024f]/g;
const LATIN_WORD = /[A-Za-z\u00c0-\u024f]{2}/;
const LETTER_ALL = /\p{L}/gu;
const LETTER = /\p{L}/u;

/**
 * Latin-script languages other than English. A page that declares one of
 * these is not English, and reading its words as English would hand a
 * translator French and ask for a translation of English.
 */
const OTHER_LATIN_LANGUAGES = new Set([
  "af", "ca", "cs", "cy", "da", "de", "es", "et", "eu", "fi", "fr", "ga", "gl", "hr",
  "hu", "id", "is", "it", "lt", "lv", "ms", "nb", "nl", "nn", "no", "pl", "pt", "ro",
  "sk", "sl", "sq", "sv", "sw", "tl", "tr", "vi"
]);

export interface PageLanguageContext {
  /** What a string of Han characters without kana is written in on this page. */
  hanLanguage: "ja" | "zh-CN";
  /** False when the page declares a Latin-script language other than English. */
  latinIsEnglish: boolean;
  /** The page's declared primary language subtag, if any. */
  declared: string | null;
}

/** Characters seen so far on the page, which decide what bare Han text is. */
export interface ScriptTally {
  kana: number;
  han: number;
}

export function emptyScriptTally(): ScriptTally {
  return { kana: 0, han: 0 };
}

export function tallyScripts(tally: ScriptTally, text: string): void {
  tally.kana += text.match(KANA_ALL)?.length ?? 0;
  tally.han += text.match(HAN_ALL)?.length ?? 0;
}

export function pageLanguageContext(input: {
  langAttribute: string | null | undefined;
  tally: ScriptTally;
}): PageLanguageContext {
  const declared = input.langAttribute?.trim().toLocaleLowerCase().split(/[-_]/)[0] || null;
  const { kana, han } = input.tally;
  let hanLanguage: "ja" | "zh-CN";
  if (kana + han >= 40) {
    // Japanese prose is a third to a half kana; Chinese has none. The page's
    // own text outvotes a `lang` attribute, which templates often leave wrong.
    hanLanguage = kana / (kana + han) >= 0.08 ? "ja" : "zh-CN";
  } else if (declared === "ja" || kana > 0) {
    hanLanguage = "ja";
  } else {
    hanLanguage = "zh-CN";
  }
  return {
    hanLanguage,
    latinIsEnglish: !declared || !OTHER_LATIN_LANGUAGES.has(declared),
    declared
  };
}

/**
 * The supported language a string is written in, or null when it is none of
 * them or has nothing to translate (numbers, symbols, a lone letter).
 */
export function detectTextLanguage(
  text: string,
  context: Pick<PageLanguageContext, "hanLanguage" | "latinIsEnglish">
): LanguageTag | null {
  if (KANA.test(text)) {
    return "ja";
  }
  if (HANGUL.test(text)) {
    return null;
  }
  const latin = text.match(LATIN_ALL)?.length ?? 0;
  const han = text.match(HAN_ALL)?.length ?? 0;
  // English with a word or two in Han characters is still English: asked as
  // Japanese or Chinese, a translator would hand the English back untouched.
  const latinLeads = context.latinIsEnglish && LATIN_WORD.test(text) && latin >= han * 2;
  if (han > 0 && !latinLeads) {
    const simplified = SIMPLIFIED_ONLY.test(text);
    const japanese = JAPANESE_ONLY.test(text);
    if (simplified !== japanese) {
      return simplified ? "zh-CN" : "ja";
    }
    return context.hanLanguage;
  }
  if (!context.latinIsEnglish || !LATIN_WORD.test(text)) {
    return null;
  }
  // English words inside Russian or Greek text do not make it English.
  const letters = text.match(LETTER_ALL)?.length ?? 0;
  return latin * 2 >= letters ? "en" : null;
}

/** Whether a string has anything a translator could change. */
export function hasLetters(text: string): boolean {
  return LETTER.test(text);
}
