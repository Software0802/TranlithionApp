import { languageEnglishName, type LanguageTag } from "../shared/language";
import { normalizeGlossary } from "../shared/settings";
import { mergeTerminology } from "../shared/terminology";
import type {
  ContextLine,
  EntityHint,
  GlossaryEntry,
  SubtitleCue,
  TranslationFailure,
  TranslationResult,
  TranslationSettings
} from "../shared/types";

const REQUEST_TIMEOUT_MS = 15_000;
/** A service already warmed this recently still has its connection open. */
const WARM_UP_INTERVAL_MS = 30_000;
const WARM_UP_TIMEOUT_MS = 5_000;
const lastWarmUpAt = new Map<string, number>();

export class TranslatorError extends Error {
  constructor(
    public readonly code: TranslationFailure["code"],
    message: string
  ) {
    super(message);
    this.name = "TranslatorError";
  }
}

export interface TranslationAgentInput {
  cue: SubtitleCue;
  settings: TranslationSettings;
  recentContext: ContextLine[];
  rememberedTerms: GlossaryEntry[];
  signal?: AbortSignal;
  onPartial?: (text: string) => void;
}

const DEMO_TRANSLATIONS: Record<string, string> = {
  "こんにちは": "你好。",
  "ありがとう": "谢谢。",
  "お願いします": "拜托了。",
  "大丈夫です": "没关系。",
  "行きましょう": "我们走吧。",
  "おはようございます": "早上好。"
};

export async function translateWithAgent(
  input: TranslationAgentInput
): Promise<TranslationResult> {
  if (input.signal?.aborted) {
    throw cancelledTranslation();
  }
  const startedAt = performance.now();
  let result: Omit<TranslationResult, "latencyMs">;

  switch (input.settings.provider) {
    case "mock":
      result = translateWithMock(input.cue);
      break;
    case "websocket":
      result = await translateWithWebSocket(input);
      break;
    case "openai-compatible":
      result = await translateWithOpenAiCompatibleApi(input);
      break;
    default:
      throw new TranslatorError("UNKNOWN", "不支持的翻译服务类型。");
  }

  return {
    ...result,
    latencyMs: Math.round(performance.now() - startedAt)
  };
}

function cancelledTranslation(): TranslatorError {
  return new TranslatorError("CANCELLED", "字幕已更新，已取消过期翻译。");
}

/**
 * Opens the connection the first caption will need before it is needed.
 *
 * A first request to a translation service pays DNS, TCP and TLS before any
 * token can come back — a few hundred milliseconds that would otherwise land
 * on the first line the viewer reads. This is sent when captions appear on a
 * page, and the browser keeps the connection for the caption requests that
 * follow. It carries neither the key nor any caption text.
 */
export async function warmUpTranslator(
  settings: TranslationSettings,
  nowMs = Date.now()
): Promise<void> {
  if (settings.provider === "openai-compatible") {
    await warmUpEndpoint(chatCompletionsEndpoint(settings.apiBaseUrl), nowMs);
    return;
  }
  if (settings.provider === "websocket" && claimWarmUp(settings.webSocketUrl, nowMs)) {
    socketPoolFor(settings.webSocketUrl).warm();
  }
}

/** The same for any HTTP translation endpoint, such as the draft channel's. */
export async function warmUpEndpoint(url: string, nowMs = Date.now()): Promise<void> {
  if (!claimWarmUp(url, nowMs)) {
    return;
  }
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), WARM_UP_TIMEOUT_MS);
  try {
    // Any answer will do, an error status included: the connection is what
    // is being opened. The caption's own request reports real failures.
    await fetch(url, { method: "HEAD", signal: controller.signal });
  } catch {
    // Unreachable now is reported by the first caption that needs it.
  } finally {
    globalThis.clearTimeout(timer);
  }
}

/** Whether this endpoint is due a warm-up, marking it warmed if so. */
function claimWarmUp(endpoint: string, nowMs: number): boolean {
  const lastAt = lastWarmUpAt.get(endpoint);
  if (lastAt !== undefined && nowMs - lastAt < WARM_UP_INTERVAL_MS) {
    return false;
  }
  lastWarmUpAt.set(endpoint, nowMs);
  return true;
}

function translateWithMock(cue: SubtitleCue): Omit<TranslationResult, "latencyMs"> {
  return {
    text: DEMO_TRANSLATIONS[cue.text] ?? `【演示翻译】${cue.text}`,
    provider: "mock",
    entityHints: []
  };
}

async function translateWithOpenAiCompatibleApi(
  input: TranslationAgentInput
): Promise<Omit<TranslationResult, "latencyMs">> {
  const { settings } = input;
  if (!settings.apiKey) {
    throw new TranslatorError(
      "NOT_CONFIGURED",
      "尚未保存 API Key。请在扩展设置中完成翻译服务配置。"
    );
  }

  const terminology = mergeTerminology(settings.glossary, input.rememberedTerms);
  const controller = new AbortController();
  const cancelForNewerCue = () => controller.abort();
  if (input.signal?.aborted) {
    controller.abort();
  } else {
    input.signal?.addEventListener("abort", cancelForNewerCue, { once: true });
  }
  const timer = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(chatCompletionsEndpoint(settings.apiBaseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.15,
        max_tokens: input.onPartial ? streamingTokenBudget(input.cue.text) : 400,
        stream: Boolean(input.onPartial),
        ...(shouldDisableDeepSeekThinking(settings) ? { thinking: { type: "disabled" } } : {}),
        messages: [
          {
            role: "system",
            content: input.onPartial
              ? streamingTranslationSystemPrompt(
                  settings.sourceLanguage,
                  settings.targetLanguage,
                  terminology
                )
              : translationSystemPrompt(
                  settings.sourceLanguage,
                  settings.targetLanguage,
                  terminology
                )
          },
          {
            role: "user",
            content: JSON.stringify(
              input.onPartial
                ? {
                    context: input.recentContext.map(contextEntry),
                    cue: input.cue.text,
                    ...(input.cue.speaker ? { speaker: input.cue.speaker } : {})
                  }
                : {
                    task: "Translate the current subtitle cue only.",
                    context: input.recentContext.map(contextEntry),
                    cue: input.cue.text,
                    ...(input.cue.speaker ? { speaker: input.cue.speaker } : {}),
                    output_contract: {
                      translation: `${languageEnglishName(settings.targetLanguage)} subtitle only`,
                      entities: [
                        {
                          source: "new proper name or term in source language",
                          target: `${languageEnglishName(settings.targetLanguage)} rendering`,
                          kind: "name or term"
                        }
                      ]
                    }
                  }
            )
          }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new TranslatorError(
        "PROVIDER",
        `翻译服务返回 HTTP ${response.status}。请检查模型、API Key 和服务地址。`
      );
    }

    if (input.onPartial && response.headers.get("content-type")?.includes("text/event-stream")) {
      return readStreamingTranslation(response, input);
    }

    const payload: unknown = await response.json();
    const content = extractMessageContent(payload);
    return parseTranslation(content, "openai-compatible");
  } catch (error) {
    if (error instanceof TranslatorError) {
      throw error;
    }
    if (input.signal?.aborted) {
      throw cancelledTranslation();
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new TranslatorError("TIMEOUT", "翻译请求超时，请稍后重试。");
    }
    throw new TranslatorError("NETWORK", "无法连接到翻译服务。请检查网络和服务地址。");
  } finally {
    globalThis.clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancelForNewerCue);
  }
}

/** Connections kept open between captions; one is enough for a caption and its prefetch. */
const IDLE_SOCKET_LIMIT = 2;
/**
 * An idle socket older than this is not trusted: after a sleep or a network
 * change it can still read as open while nothing on it arrives any more.
 */
const IDLE_SOCKET_MAX_AGE_MS = 60_000;

/**
 * Open WebSockets to one translation server, reused between captions.
 *
 * Opening a WebSocket costs a TCP and TLS handshake and an HTTP upgrade: round
 * trips every caption used to pay again before its request could be sent. A
 * socket that has answered is now kept for the next caption instead of being
 * closed. Each socket still carries one request at a time, so the server sees
 * what it always saw — one question and one answer per connection at a time —
 * and a caption that is cancelled or times out closes its socket as before,
 * rather than leaving the next caption queued behind it on a shared line.
 */
class TranslationSocketPool {
  private idle: Array<{ socket: WebSocket; since: number }> = [];
  /** Opened ahead of the first caption and not yet handed to one. */
  private warming: WebSocket | null = null;

  constructor(readonly url: string) {}

  /** A socket for one request: one still opening, an idle open one, or a new one. */
  take(nowMs = Date.now()): WebSocket {
    const warming = this.warming;
    this.warming = null;
    if (
      warming &&
      (warming.readyState === WebSocket.CONNECTING || warming.readyState === WebSocket.OPEN)
    ) {
      return warming;
    }
    while (this.idle.length > 0) {
      const entry = this.idle.pop();
      if (
        entry &&
        entry.socket.readyState === WebSocket.OPEN &&
        nowMs - entry.since < IDLE_SOCKET_MAX_AGE_MS
      ) {
        return entry.socket;
      }
      if (entry) {
        closeQuietly(entry.socket);
      }
    }
    return new WebSocket(this.url);
  }

  /** Keeps a socket whose request was answered, for the next caption. */
  release(socket: WebSocket, nowMs = Date.now()): void {
    if (socket.readyState !== WebSocket.OPEN) {
      closeQuietly(socket);
      return;
    }
    socket.onopen = null;
    socket.onerror = null;
    // Nothing is waiting on an idle socket; whatever arrives on it is dropped.
    socket.onmessage = null;
    socket.onclose = () => {
      this.idle = this.idle.filter((entry) => entry.socket !== socket);
    };
    this.idle.push({ socket, since: nowMs });
    while (this.idle.length > IDLE_SOCKET_LIMIT) {
      const oldest = this.idle.shift();
      if (oldest) {
        closeQuietly(oldest.socket);
      }
    }
  }

  /** Opens a socket before the first caption needs one. */
  warm(nowMs = Date.now()): void {
    const hasOpenIdle = this.idle.some(
      (entry) =>
        entry.socket.readyState === WebSocket.OPEN && nowMs - entry.since < IDLE_SOCKET_MAX_AGE_MS
    );
    if (this.warming || hasOpenIdle) {
      return;
    }
    const socket = new WebSocket(this.url);
    this.warming = socket;
    socket.onopen = () => {
      if (this.warming === socket) {
        this.warming = null;
        this.release(socket);
      }
    };
    socket.onerror = null;
    socket.onclose = () => {
      if (this.warming === socket) {
        this.warming = null;
      }
    };
    // A handshake that never completes is abandoned rather than kept pending.
    globalThis.setTimeout(() => {
      if (this.warming === socket && socket.readyState !== WebSocket.OPEN) {
        this.warming = null;
        closeQuietly(socket);
      }
    }, WARM_UP_TIMEOUT_MS);
  }

  close(): void {
    const warming = this.warming;
    this.warming = null;
    if (warming) {
      closeQuietly(warming);
    }
    for (const entry of this.idle.splice(0)) {
      closeQuietly(entry.socket);
    }
  }
}

function closeQuietly(socket: WebSocket): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close();
  }
}

let socketPool: TranslationSocketPool | null = null;

/** The pool for this server; a changed address closes the old one's sockets. */
function socketPoolFor(url: string): TranslationSocketPool {
  if (socketPool?.url !== url) {
    socketPool?.close();
    socketPool = new TranslationSocketPool(url);
  }
  return socketPool;
}

async function translateWithWebSocket(
  input: TranslationAgentInput
): Promise<Omit<TranslationResult, "latencyMs">> {
  if (input.signal?.aborted) {
    throw cancelledTranslation();
  }
  const requestId = crypto.randomUUID();
  const payload = {
    type: "translate",
    requestId,
    sourceLanguage: input.settings.sourceLanguage,
    targetLanguage: input.settings.targetLanguage,
    cue: input.cue,
    context: input.recentContext,
    terminology: mergeTerminology(input.settings.glossary, input.rememberedTerms)
  };
  const pool = socketPoolFor(input.settings.webSocketUrl);

  return new Promise((resolve, reject) => {
    let settled = false;
    let abortHandler: (() => void) | null = null;
    const socket = pool.take();
    const timeout = globalThis.setTimeout(() => {
      finishWithError(new TranslatorError("TIMEOUT", "翻译 WebSocket 连接超时。"));
    }, REQUEST_TIMEOUT_MS);

    /**
     * A socket goes back to the pool only after a clean answer. One that was
     * cancelled, timed out or sent something unreadable is closed, exactly as
     * every socket used to be.
     */
    const cleanup = (keepSocket: boolean) => {
      globalThis.clearTimeout(timeout);
      if (abortHandler) {
        input.signal?.removeEventListener("abort", abortHandler);
      }
      if (keepSocket) {
        pool.release(socket);
      } else {
        closeQuietly(socket);
      }
    };
    const finishWithError = (error: TranslatorError, keepSocket = false) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup(keepSocket);
      reject(error);
    };
    const finish = (result: Omit<TranslationResult, "latencyMs">) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup(true);
      resolve(result);
    };
    let sent = false;
    const send = () => {
      if (sent || settled) {
        return;
      }
      sent = true;
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        finishWithError(new TranslatorError("NETWORK", "翻译 WebSocket 服务意外断开。"));
      }
    };

    socket.onopen = send;
    socket.onerror = () => {
      finishWithError(new TranslatorError("NETWORK", "无法连接到翻译 WebSocket 服务。"));
    };
    socket.onclose = () => {
      if (!settled) {
        finishWithError(new TranslatorError("NETWORK", "翻译 WebSocket 服务意外断开。"));
      }
    };
    socket.onmessage = (event) => {
      try {
        const response = JSON.parse(String(event.data)) as {
          requestId?: string;
          translation?: unknown;
          entities?: unknown;
          error?: unknown;
        };
        if (response.requestId !== requestId) {
          return;
        }
        if (typeof response.error === "string") {
          finishWithError(new TranslatorError("PROVIDER", response.error), true);
          return;
        }
        if (typeof response.translation !== "string" || !response.translation.trim()) {
          finishWithError(
            new TranslatorError("INVALID_RESPONSE", "翻译服务未返回有效字幕。"),
            true
          );
          return;
        }
        finish({
          text: response.translation.trim(),
          provider: "websocket",
          entityHints: toEntityHints(response.entities)
        });
      } catch {
        finishWithError(new TranslatorError("INVALID_RESPONSE", "翻译服务返回了无法解析的数据。"));
      }
    };

    abortHandler = () => finishWithError(cancelledTranslation());
    if (input.signal?.aborted) {
      abortHandler();
    } else {
      input.signal?.addEventListener("abort", abortHandler, { once: true });
    }
    if (socket.readyState === WebSocket.OPEN) {
      send();
    }
  });
}

/**
 * Room for one caption's translation. A hard cap is what stops a model that
 * starts explaining itself, but a long or merged line must not be cut off
 * mid-sentence and then cached as if it were the whole translation.
 */
function streamingTokenBudget(text: string): number {
  return Math.min(400, Math.max(96, 64 + text.length * 2));
}

export function shouldDisableDeepSeekThinking(settings: TranslationSettings): boolean {
  try {
    return new URL(settings.apiBaseUrl).hostname === "api.deepseek.com" &&
      settings.model.toLocaleLowerCase().startsWith("deepseek-");
  } catch {
    return false;
  }
}

/**
 * Context lines carry the speaker when the source had one, so the model can
 * tell a two-person exchange apart across cues.
 */
function contextEntry(line: ContextLine): {
  source: string;
  translation: string;
  speaker?: string;
} {
  return {
    source: line.source,
    translation: line.translation,
    ...(line.speaker ? { speaker: line.speaker } : {})
  };
}

function streamingTranslationSystemPrompt(
  sourceLanguage: LanguageTag,
  targetLanguage: LanguageTag,
  terminology: GlossaryEntry[]
): string {
  const source = languageEnglishName(sourceLanguage);
  const target = languageEnglishName(targetLanguage);
  return withTerminology(
    [
      `You are a real-time ${source}-to-${target} subtitle translator for captions.`,
      `Render natural spoken ${target} a viewer can read at a glance—not word-for-word calque.`,
      "Prefer meaning, tone, and speaker intent over literal diction; keep names and fixed terms consistent with context.",
      "A `speaker` field names who is talking: use it for pronouns and register, and never repeat it in the output.",
      `Keep it concise for on-screen subtitles. Return only the ${target} subtitle text; no JSON, labels, notes, or explanation.`
    ].join(" "),
    terminology
  );
}

/**
 * Terminology lives in the system message because providers cache on an exact
 * prompt prefix. The glossary only ever grows by appending within a session, so
 * keeping it ahead of the sliding context preserves a long stable prefix; the
 * per-cue context and cue text stay in the user message where they change on
 * every request anyway.
 */
function withTerminology(instructions: string, terminology: GlossaryEntry[]): string {
  if (terminology.length === 0) {
    return instructions;
  }
  const renderings = terminology
    .map((entry) => `${entry.source}=${entry.target}`)
    .join("; ");
  return `${instructions}\nAlways use these fixed renderings: ${renderings}`;
}

async function readStreamingTranslation(
  response: Response,
  input: TranslationAgentInput
): Promise<Omit<TranslationResult, "latencyMs">> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new TranslatorError("INVALID_RESPONSE", "翻译服务未返回可读取的流式响应。");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let translation = "";
  const consumeLine = (line: string) => {
    const delta = streamDelta(line);
    if (!delta) {
      return;
    }
    translation += delta;
    input.onPartial?.(translation);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        consumeLine(line);
      }
      if (done) {
        break;
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      consumeLine(buffer);
    }
  } finally {
    reader.releaseLock();
  }

  if (!translation.trim()) {
    throw new TranslatorError("INVALID_RESPONSE", "翻译服务未返回有效的流式中文译文。");
  }
  return {
    text: translation.trim(),
    provider: "openai-compatible",
    entityHints: []
  };
}

function streamDelta(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return "";
  }
  const payloadText = trimmed.slice(5).trim();
  if (!payloadText || payloadText === "[DONE]") {
    return "";
  }
  try {
    const payload = JSON.parse(payloadText) as {
      choices?: Array<{ delta?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.delta?.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part === "object" && part !== null ? (part as { text?: unknown }).text : ""))
        .filter((part): part is string => typeof part === "string")
        .join("");
    }
  } catch {
    // SSE keep-alives and non-content chunks are intentionally ignored.
  }
  return "";
}

function translationSystemPrompt(
  sourceLanguage: LanguageTag,
  targetLanguage: LanguageTag,
  terminology: GlossaryEntry[]
): string {
  const source = languageEnglishName(sourceLanguage);
  const target = languageEnglishName(targetLanguage);
  return withTerminology([
    `You are a real-time ${source}-to-${target} subtitle translator for captions.`,
    `Prioritize natural, concise ${target} that fits on-screen subtitles—not word-for-word calque.`,
    "Preserve meaning, tone, speaker intent, proper names, and terminology across nearby cues.",
    "A `speaker` field names who is talking: use it for pronouns and register, and never repeat it in the output.",
    `Prefer idiomatic ${target} over literal diction when both are faithful.`,
    "Do not explain, annotate, censor, or repeat the source text.",
    "Return one JSON object only, with this exact shape:",
    '{"translation":"…","entities":[{"source":"…","target":"…","kind":"name"}]}.',
    "Use an empty entities array when there is no new reusable name or term."
  ].join(" "), terminology);
}

export function chatCompletionsEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

function extractMessageContent(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    throw new TranslatorError("INVALID_RESPONSE", "翻译服务返回了空响应。");
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new TranslatorError("INVALID_RESPONSE", "翻译服务没有返回候选译文。");
  }
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part !== null ? (part as { text?: unknown }).text : ""))
      .filter((part): part is string => typeof part === "string")
      .join("\n");
  }
  throw new TranslatorError("INVALID_RESPONSE", "翻译服务未返回文本译文。");
}

function parseTranslation(
  content: string,
  provider: "openai-compatible"
): Omit<TranslationResult, "latencyMs"> {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: { translation?: unknown; entities?: unknown } | null = null;
  try {
    parsed = JSON.parse(cleaned) as { translation?: unknown; entities?: unknown };
  } catch {
    const objectMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        parsed = JSON.parse(objectMatch[0]) as { translation?: unknown; entities?: unknown };
      } catch {
        parsed = null;
      }
    }
  }

  if (parsed && typeof parsed.translation === "string" && parsed.translation.trim()) {
    return {
      text: parsed.translation.trim(),
      provider,
      entityHints: toEntityHints(parsed.entities)
    };
  }

  if (cleaned && !cleaned.startsWith("{")) {
    return { text: cleaned, provider, entityHints: [] };
  }
  throw new TranslatorError("INVALID_RESPONSE", "翻译服务未返回有效的中文译文。");
}

function toEntityHints(value: unknown): EntityHint[] {
  return normalizeGlossary(value).map((entry) => ({ ...entry }));
}
