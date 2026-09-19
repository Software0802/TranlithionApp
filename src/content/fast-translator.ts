import type {
  DraftTranslationResponse,
  ExtensionMessage,
  PlainTranslationResponse
} from "../shared/messages";
import { safeRuntimeSendMessage } from "../shared/extension-context";
import { toShortLanguageCode } from "../shared/language";
import type {
  PublicTranslationSettings,
  SourceLanguage,
  TargetLanguage
} from "../shared/types";

/**
 * Draft channel backed by Chrome's on-device Translator API.
 *
 * The LLM channel needs roughly 1–2 seconds just to emit its first token,
 * which is longer than a Netflix caption stays on screen. This channel runs
 * locally and normally answers in tens of milliseconds, so a readable draft
 * can replace the blank overlay while the higher quality translation is still
 * streaming in behind it.
 *
 * Every entry point degrades to "unavailable" instead of throwing. The API is
 * absent in older Chrome builds, content scripts run in an isolated world that
 * may not expose it, and ja→zh is not a guaranteed language pair. In all of
 * those cases the caller keeps its existing LLM-only behaviour.
 */

/**
 * Probing can hang indefinitely when the browser exposes the API but cannot
 * reach its on-device model backend, so every await here is bounded. Losing the
 * draft costs nothing; a promise that never settles would leak one pending
 * translation per caption.
 */
const PREPARE_TIMEOUT_MS = 10_000;
/** A draft slower than this is pointless: the service answer is already close. */
const DRAFT_TIMEOUT_MS = 800;
/**
 * When this channel *is* the caption (meeting mode), nothing slower is waiting
 * behind it. A cold on-device model or a long sentence is worth waiting for;
 * giving up at the draft budget would drop the line entirely.
 */
const FINAL_CHANNEL_TIMEOUT_MS = 4_000;

/**
 * A source of immediate, lower-quality captions. Implementations must resolve
 * to null rather than throwing: the draft is an enhancement, and its failure
 * must never disturb the main translation path.
 */
export interface DraftChannel {
  /** Warms the channel. Returns false when it cannot serve this browser or config. */
  prepare(): Promise<boolean>;
  translate(text: string, signal?: AbortSignal): Promise<string | null>;
  destroy(): void;
}

type TranslatorAvailability = "unavailable" | "downloadable" | "downloading" | "available";

interface TranslatorLanguagePair {
  sourceLanguage: string;
  targetLanguage: string;
}

interface TranslatorInstance {
  translate: (input: string) => Promise<string>;
  destroy?: () => void;
}

interface TranslatorFactory {
  availability: (options: TranslatorLanguagePair) => Promise<TranslatorAvailability>;
  create: (options: TranslatorLanguagePair) => Promise<TranslatorInstance>;
}

/** Resolves to null instead of hanging or rejecting, whichever comes first. */
function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(() => resolve(null), timeoutMs);
    const settle = (value: T | null) => {
      globalThis.clearTimeout(timer);
      resolve(value);
    };
    work.then(settle, () => settle(null));
  });
}

/** The Translator API expects a base BCP-47 tag; `zh-CN` is rejected by some builds. */
function toTranslatorLanguage(language: SourceLanguage | TargetLanguage): string {
  return toShortLanguageCode(language);
}

function readTranslatorFactory(): TranslatorFactory | null {
  const candidate = (globalThis as { Translator?: unknown }).Translator;
  // Chrome exposes Translator as a class, so `typeof` is "function" rather than
  // "object". Accept either shape and let the method probe below decide.
  if (!candidate || (typeof candidate !== "object" && typeof candidate !== "function")) {
    return null;
  }
  const factory = candidate as Partial<TranslatorFactory>;
  if (typeof factory.availability !== "function" || typeof factory.create !== "function") {
    return null;
  }
  return factory as TranslatorFactory;
}

export class DraftTranslator implements DraftChannel {
  private readonly pair: TranslatorLanguagePair;
  private instance: TranslatorInstance | null = null;
  private preparation: Promise<TranslatorInstance | null> | null = null;
  private unsupported = false;

  constructor(
    sourceLanguage: SourceLanguage,
    targetLanguage: TargetLanguage,
    /** This channel is the caption the user reads, not a preview of one. */
    private readonly asFinal = false
  ) {
    this.pair = {
      sourceLanguage: toTranslatorLanguage(sourceLanguage),
      targetLanguage: toTranslatorLanguage(targetLanguage)
    };
  }

  /**
   * Warms the local model so the first caption does not pay the download cost.
   * Resolves to false when this browser cannot serve the configured pair.
   */
  async prepare(): Promise<boolean> {
    return (await this.resolveInstance()) !== null;
  }

  /**
   * Returns a draft translation, or null when the draft channel is unavailable,
   * the caller cancelled, or the model produced nothing usable.
   */
  async translate(text: string, signal?: AbortSignal): Promise<string | null> {
    const source = text.trim();
    if (!source || signal?.aborted) {
      return null;
    }
    const instance = await this.resolveInstance();
    if (!instance || signal?.aborted) {
      return null;
    }
    try {
      const translated = await withTimeout(
        instance.translate(source),
        this.asFinal ? FINAL_CHANNEL_TIMEOUT_MS : DRAFT_TIMEOUT_MS
      );
      if (signal?.aborted || typeof translated !== "string") {
        return null;
      }
      const trimmed = translated.trim();
      if (!trimmed) {
        return null;
      }
      // As a draft, an echo of the source is worse than showing nothing: it
      // would look like a finished translation that failed to translate, and
      // the real one is still on its way. As the caption itself there is
      // nothing behind it — a name or a figure simply reads the same in both
      // languages, and calling that a dead channel would be a lie.
      return this.asFinal || trimmed !== source ? trimmed : null;
    } catch {
      return null;
    }
  }

  destroy(): void {
    this.instance?.destroy?.();
    this.instance = null;
    this.preparation = null;
  }

  private resolveInstance(): Promise<TranslatorInstance | null> {
    if (this.unsupported) {
      return Promise.resolve(null);
    }
    if (this.instance) {
      return Promise.resolve(this.instance);
    }
    this.preparation ??= this.createInstance().then(
      (instance) => {
        this.instance = instance;
        if (!instance) {
          this.unsupported = true;
        }
        return instance;
      },
      () => {
        this.unsupported = true;
        return null;
      }
    );
    return this.preparation;
  }

  private async createInstance(): Promise<TranslatorInstance | null> {
    const factory = readTranslatorFactory();
    if (!factory) {
      return null;
    }
    const availability: TranslatorAvailability | null = await withTimeout(
      factory.availability(this.pair),
      PREPARE_TIMEOUT_MS
    );
    // A null here means the probe timed out or threw; treat it the same as an
    // explicit "unavailable" so the channel disables itself instead of retrying
    // a hanging call on every caption.
    if (availability === null || availability === "unavailable") {
      return null;
    }
    return withTimeout(factory.create(this.pair), PREPARE_TIMEOUT_MS);
  }
}

/**
 * Draft channel that delegates to the background worker, which holds the API
 * key for the configured machine-translation endpoint. The content script only
 * ever sends caption text and receives translated text.
 */
export class RemoteDraftTranslator implements DraftChannel {
  constructor(
    private readonly sessionId: string,
    private readonly cueIdOf: () => string,
    /** Meeting mode: this channel is the caption, so drafts being off must not disable it. */
    private readonly asFinal = false
  ) {}

  /**
   * Remote endpoints need no warm-up, and probing one would spend a request
   * before there is a caption to translate.
   */
  async prepare(): Promise<boolean> {
    return true;
  }

  async translate(text: string, signal?: AbortSignal): Promise<string | null> {
    if (!text.trim() || signal?.aborted) {
      return null;
    }
    try {
      const response = await safeRuntimeSendMessage<DraftTranslationResponse>({
        type: "DRAFT_TRANSLATE",
        sessionId: this.sessionId,
        cueId: this.cueIdOf(),
        text,
        asFinal: this.asFinal
      } satisfies ExtensionMessage);
      if (!response?.ok || typeof response.text !== "string" || signal?.aborted) {
        return null;
      }
      return response.text.trim() || null;
    } catch {
      return null;
    }
  }

  destroy(): void {
    // The background worker owns the in-flight request and aborts it when the
    // next caption arrives or the session is cleared.
  }
}

/**
 * Local LibreTranslate as a caption channel.
 *
 * The background worker already owns the endpoint and its host permission for
 * full-page translation; meeting mode reuses that path so a meeting can be
 * translated entirely on the user's own machine.
 */
export class LocalMtTranslator implements DraftChannel {
  async prepare(): Promise<boolean> {
    return true;
  }

  async translate(text: string, signal?: AbortSignal): Promise<string | null> {
    if (!text.trim() || signal?.aborted) {
      return null;
    }
    try {
      // The background's budget is the one a whole page can afford to wait
      // for. This channel is a live caption on a serialized queue, so a slow
      // local server must cost one dropped line rather than a backlog that
      // pushes every later line minutes behind the conversation.
      const response = await withTimeout(
        safeRuntimeSendMessage<PlainTranslationResponse>({
          type: "TRANSLATE_PLAIN",
          text
        } satisfies ExtensionMessage),
        FINAL_CHANNEL_TIMEOUT_MS
      );
      if (!response?.ok || typeof response.text !== "string" || signal?.aborted) {
        return null;
      }
      return response.text.trim() || null;
    } catch {
      return null;
    }
  }

  destroy(): void {
    // The background worker owns the request and its timeout.
  }
}

export function createDraftChannel(
  settings: PublicTranslationSettings,
  sessionId: string,
  cueIdOf: () => string
): DraftChannel | null {
  if (!settings.draftCaptions) {
    return null;
  }
  return createFastChannel(settings, sessionId, cueIdOf);
}

/**
 * The fast machine-translation channel itself, independent of whether the user
 * wants it as a draft. Meeting mode uses it as the final caption, so it must be
 * constructible without `draftCaptions` being on.
 */
export function createFastChannel(
  settings: PublicTranslationSettings,
  sessionId: string,
  cueIdOf: () => string,
  asFinal = false
): DraftChannel | null {
  if (settings.draftProvider === "browser") {
    return new DraftTranslator(settings.sourceLanguage, settings.targetLanguage, asFinal);
  }
  // A remote provider without a key would spend a request per caption to fail.
  if (settings.draftProvider === "deepl" && !settings.draftApiKeyConfigured) {
    return null;
  }
  return new RemoteDraftTranslator(sessionId, cueIdOf, asFinal);
}
