import {
  languageEnglishName,
  toDeepLSource,
  toDeepLTarget,
  type LanguageTag
} from "../shared/language";
import { resolvePageEngine, type PageEngine } from "../shared/page-translation";
import type { TranslationSettings } from "../shared/types";
import { translateWithLibreTranslate } from "./local-mt";
import {
  chatCompletionsEndpoint,
  shouldDisableDeepSeekThinking,
  translateWithAgent
} from "./translator";

/**
 * Page and selection text through whichever service the page channel names.
 *
 * Captions ask for one line at a time and stream it; a page arrives as dozens
 * of short strings at once and nobody is waiting on any single one of them.
 * So this path packs strings into as few requests as each service allows —
 * DeepL takes fifty per request, a chat model a JSON array — and remembers
 * every answer for the life of the worker, so the header and menu a site
 * repeats on every page are translated once.
 *
 * It never streams, never records anything to storage, and never touches a
 * caption session: page text is not a conversation with a context.
 */

export class PageTranslationError extends Error {
  constructor(
    message: string,
    /** A later request may succeed: a timeout, a rate limit, a server hiccup. */
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "PageTranslationError";
  }
}

export interface PageTranslationRequest {
  texts: string[];
  source: LanguageTag;
  target: LanguageTag;
  /** Strings carry `<t0>…</t0>` placeholder tags that must survive. */
  markup: boolean;
  settings: TranslationSettings;
}

const DEEPL_MAX_TEXTS = 50;
const HTTP_TIMEOUT_MS = 20_000;
const LLM_TIMEOUT_MS = 45_000;
/** Strings one worker sends in parallel to a service that takes one per request. */
const PER_STRING_CONCURRENCY = 4;
/** How many times a chat model's miscounted answer is split and asked again. */
const MAX_SPLIT_DEPTH = 4;
const MAX_CACHED = 5_000;

const cache = new Map<string, string>();

/** Forgets every remembered answer: the service or its settings changed. */
export function clearPageTranslationCache(): void {
  cache.clear();
}

export async function translatePageTexts(
  request: PageTranslationRequest
): Promise<Array<string | null>> {
  const engine = resolvePageEngine(request.settings);
  const prefix = cachePrefix(engine, request);
  const results: Array<string | null> = request.texts.map(
    (text) => cache.get(`${prefix}${text}`) ?? null
  );
  const missing = request.texts
    .map((text, index) => ({ text, index }))
    .filter(({ index }) => results[index] === null);
  if (missing.length === 0) {
    return results;
  }
  const answered = await translateWithEngine(engine, {
    ...request,
    texts: missing.map(({ text }) => text)
  });
  missing.forEach(({ text, index }, position) => {
    const translation = answered[position]?.trim() || null;
    results[index] = translation;
    if (translation) {
      remember(`${prefix}${text}`, translation);
    }
  });
  return results;
}

/**
 * Every answer is keyed by the service that gave it and the pair it was asked
 * in, so a changed endpoint, model or language never serves an old answer.
 */
function cachePrefix(engine: PageEngine, request: PageTranslationRequest): string {
  const { settings } = request;
  const service =
    engine === "deepl" || engine === "custom"
      ? settings.draftEndpointUrl
      : engine === "libretranslate"
        ? settings.localMtUrl
        : engine === "openai-compatible"
          ? `${settings.apiBaseUrl}|${settings.model}`
          : engine === "websocket"
            ? settings.webSocketUrl
            : "";
  return `${engine}|${service}|${request.source}>${request.target}|${request.markup ? "m" : "p"}|`;
}

function remember(key: string, translation: string): void {
  cache.delete(key);
  cache.set(key, translation);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
}

async function translateWithEngine(
  engine: PageEngine,
  request: PageTranslationRequest
): Promise<Array<string | null>> {
  switch (engine) {
    case "deepl":
      return translateWithDeepL(request);
    case "custom":
      return everyStringOrFail(
        await mapWithConcurrency(request.texts, PER_STRING_CONCURRENCY, (text) =>
          translateWithCustomEndpoint(text, request)
        ),
        `自定义机器翻译服务（${hostOf(request.settings.draftEndpointUrl)}）没有返回译文。请检查服务地址与 Key。`
      );
    case "libretranslate":
      return everyStringOrFail(
        await mapWithConcurrency(request.texts, PER_STRING_CONCURRENCY, (text) =>
          translateWithLibreTranslate(text, request.settings, undefined, {
            source: request.source,
            target: request.target
          })
        ),
        `LibreTranslate（${hostOf(request.settings.localMtUrl)}）没有返回译文。请确认它已经启动，并且装了这个语言对的模型。`
      );
    case "openai-compatible":
      return translateWithChatModel(request, request.texts, 0);
    case "websocket":
      return mapWithConcurrency(request.texts, 2, (text) => translateOneWithAgent(text, request));
    case "mock":
      return request.texts.map((text) => `【演示翻译】${text}`);
    case "browser":
    default:
      throw new PageTranslationError(
        "Chrome 内置翻译在页面里运行，不经过扩展后台。请刷新页面后重试。",
        false
      );
  }
}

/**
 * Some strings failing is a partial answer; every string failing is a service
 * that is down or misconfigured, and the page should say so rather than keep
 * asking it.
 */
function everyStringOrFail(results: Array<string | null>, message: string): Array<string | null> {
  if (results.length > 0 && results.every((result) => result === null)) {
    throw new PageTranslationError(message, false);
  }
  return results;
}

/* --------------------------------------------------------------- DeepL */

async function translateWithDeepL(request: PageTranslationRequest): Promise<Array<string | null>> {
  const { settings } = request;
  if (!settings.draftApiKey) {
    throw new PageTranslationError(
      "尚未填写 DeepL API Key：请在设置页「草稿翻译 API Key」中填写。",
      false
    );
  }
  const results: Array<string | null> = [];
  for (let offset = 0; offset < request.texts.length; offset += DEEPL_MAX_TEXTS) {
    const chunk = request.texts.slice(offset, offset + DEEPL_MAX_TEXTS);
    const response = await timedFetch(settings.draftEndpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `DeepL-Auth-Key ${settings.draftApiKey}`
      },
      body: JSON.stringify({
        text: chunk,
        source_lang: toDeepLSource(request.source),
        target_lang: toDeepLTarget(request.target),
        // Our placeholders are well-formed XML; DeepL keeps them around the
        // words they enclose instead of translating them as text.
        ...(request.markup ? { tag_handling: "xml" } : {})
      })
    }, "DeepL");
    if (!response.ok) {
      throw deepLFailure(response.status);
    }
    const payload: unknown = await response.json().catch(() => null);
    const translations = (payload as { translations?: unknown } | null)?.translations;
    if (!Array.isArray(translations)) {
      throw new PageTranslationError("DeepL 返回了无法读取的数据。", true);
    }
    chunk.forEach((_, index) => {
      const text = (translations[index] as { text?: unknown } | undefined)?.text;
      results.push(typeof text === "string" ? text : null);
    });
  }
  return results;
}

function deepLFailure(status: number): PageTranslationError {
  switch (status) {
    case 403:
      return new PageTranslationError(
        "DeepL 拒绝了请求（HTTP 403）：请检查 DeepL API Key，以及免费版 / 付费版地址是否对应。",
        false
      );
    case 456:
      return new PageTranslationError(
        "DeepL 字符额度已用完（HTTP 456）。可以在设置里换一个网页翻译通道，或等额度重置。",
        false
      );
    case 429:
      return new PageTranslationError("DeepL 请求过于频繁（HTTP 429），请稍后再试。", true);
    default:
      return new PageTranslationError(`DeepL 返回 HTTP ${status}。`, status >= 500);
  }
}

/* ------------------------------------------------------- custom HTTP */

async function translateWithCustomEndpoint(
  text: string,
  request: PageTranslationRequest
): Promise<string | null> {
  const { settings } = request;
  try {
    const response = await timedFetch(settings.draftEndpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(settings.draftApiKey ? { Authorization: `Bearer ${settings.draftApiKey}` } : {})
      },
      body: JSON.stringify({ text, source: request.source, target: request.target })
    }, "自定义机器翻译服务");
    if (!response.ok) {
      return null;
    }
    const payload: unknown = await response.json().catch(() => null);
    const translation = (payload as { translation?: unknown } | null)?.translation;
    return typeof translation === "string" ? translation : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------- chat model */

/**
 * A chat model gets the strings as a JSON array and answers with one
 * translation per string. When it miscounts — merges two strings, drops an
 * empty one — the batch is halved and asked again, down to single strings,
 * rather than guessing which answer belongs to which string.
 */
async function translateWithChatModel(
  request: PageTranslationRequest,
  texts: string[],
  depth: number
): Promise<Array<string | null>> {
  const answer = await askChatModel(request, texts);
  if (answer && answer.length === texts.length) {
    return answer;
  }
  if (texts.length === 1 || depth >= MAX_SPLIT_DEPTH) {
    return texts.map(() => null);
  }
  const middle = Math.ceil(texts.length / 2);
  const [head, tail] = await Promise.all([
    translateWithChatModel(request, texts.slice(0, middle), depth + 1),
    translateWithChatModel(request, texts.slice(middle), depth + 1)
  ]);
  return [...head, ...tail];
}

async function askChatModel(
  request: PageTranslationRequest,
  texts: string[]
): Promise<Array<string | null> | null> {
  const { settings } = request;
  if (!settings.apiKey) {
    throw new PageTranslationError("尚未保存 API Key。请在扩展设置中完成翻译服务配置。", false);
  }
  const chars = texts.reduce((total, text) => total + text.length, 0);
  const response = await timedFetch(
    chatCompletionsEndpoint(settings.apiBaseUrl),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.2,
        max_tokens: Math.min(8_000, 256 + Math.ceil(chars * 3)),
        stream: false,
        ...(shouldDisableDeepSeekThinking(settings) ? { thinking: { type: "disabled" } } : {}),
        messages: [
          { role: "system", content: pageSystemPrompt(request) },
          { role: "user", content: JSON.stringify(texts) }
        ]
      })
    },
    "大模型翻译服务",
    LLM_TIMEOUT_MS
  );
  if (!response.ok) {
    throw chatModelFailure(response.status);
  }
  const payload: unknown = await response.json().catch(() => null);
  return readChatTranslations(payload, texts.length);
}

function pageSystemPrompt(request: Pick<PageTranslationRequest, "source" | "target">): string {
  const source = languageEnglishName(request.source);
  const target = languageEnglishName(request.target);
  return [
    `You translate text from a web page from ${source} to ${target}.`,
    `The user message is a JSON array of strings. Reply with only a JSON object {"translations": [...]} holding exactly one ${target} string per input string, in the same order.`,
    "Some strings contain placeholder tags such as <t0>…</t0> and <x1/>. They mark links, emphasis and inline elements: keep every tag exactly as written and in the same order, and translate the words inside and around them.",
    `Write natural ${target} for someone reading the page. Keep names, numbers, URLs and code unchanged.`,
    "Never merge, split, skip, explain or annotate strings."
  ].join(" ");
}

function readChatTranslations(payload: unknown, expected: number): Array<string | null> | null {
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> } | null)
    ?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return null;
  }
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    try {
      parsed = match ? JSON.parse(match[0]) : undefined;
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) {
      // Asked for one string, a model sometimes just answers with it.
      return expected === 1 && cleaned && !cleaned.startsWith("{") ? [cleaned] : null;
    }
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { translations?: unknown } | null)?.translations;
  if (!Array.isArray(list)) {
    return null;
  }
  return list.map((item) => (typeof item === "string" ? item : null));
}

function chatModelFailure(status: number): PageTranslationError {
  if (status === 401 || status === 403) {
    return new PageTranslationError(
      `大模型翻译服务拒绝了请求（HTTP ${status}）：请检查 API Key 与服务地址。`,
      false
    );
  }
  if (status === 429) {
    return new PageTranslationError("大模型翻译服务请求过于频繁（HTTP 429），请稍后再试。", true);
  }
  return new PageTranslationError(`大模型翻译服务返回 HTTP ${status}。`, status >= 500);
}

/* ------------------------------------------------ self-hosted socket */

async function translateOneWithAgent(
  text: string,
  request: PageTranslationRequest
): Promise<string | null> {
  try {
    const result = await translateWithAgent({
      cue: {
        id: `page-${crypto.randomUUID()}`,
        startMs: 0,
        endMs: null,
        text,
        isFinal: true,
        source: "text-track"
      },
      settings: {
        ...request.settings,
        sourceLanguage: request.source,
        targetLanguage: request.target
      },
      recentContext: [],
      rememberedTerms: []
    });
    return result.text;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ helpers */

async function timedFetch(
  url: string,
  init: RequestInit,
  serviceName: string,
  timeoutMs = HTTP_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new PageTranslationError(`${serviceName}没有在 ${Math.round(timeoutMs / 1_000)} 秒内答复。`, true);
    }
    throw new PageTranslationError(
      `无法连接${serviceName}（${hostOf(url)}）：${error instanceof Error ? error.message : "网络错误"}。`,
      true
    );
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, worker));
  return results;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
