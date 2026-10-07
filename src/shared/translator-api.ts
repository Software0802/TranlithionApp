import { toShortLanguageCode, type LanguageTag } from "./language";

/**
 * Chrome's on-device Translator API, shared by every page that runs it: the
 * caption draft channel and the page translator in the content script, and
 * the side panel.
 *
 * The API is absent in older Chrome builds and not every language pair is
 * supported, so nothing here assumes it exists. Two more rules shape it: a
 * site may only create a translator for a pair it has not used before from
 * inside a click or key press, and every await on the model is bounded,
 * because a browser can expose the API while its model backend never answers.
 */

export type TranslatorAvailability = "unavailable" | "downloadable" | "downloading" | "available";

export interface TranslatorLanguagePair {
  sourceLanguage: string;
  targetLanguage: string;
}

export interface TranslatorInstance {
  translate: (input: string) => Promise<string>;
  destroy?: () => void;
}

export interface TranslatorCreateOptions extends TranslatorLanguagePair {
  monitor?: (monitor: EventTarget) => void;
}

export interface TranslatorFactory {
  availability: (options: TranslatorLanguagePair) => Promise<TranslatorAvailability>;
  create: (options: TranslatorCreateOptions) => Promise<TranslatorInstance>;
}

/** Resolves to null instead of hanging or rejecting, whichever comes first. */
export function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = globalThis.setTimeout(() => resolve(null), timeoutMs);
    const settle = (value: T | null) => {
      globalThis.clearTimeout(timer);
      resolve(value);
    };
    work.then(settle, () => settle(null));
  });
}

export function readTranslatorFactory(): TranslatorFactory | null {
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

/** The Translator API expects a base BCP-47 tag; `zh-CN` is rejected by some builds. */
export function translatorPair(source: LanguageTag, target: LanguageTag): TranslatorLanguagePair {
  return {
    sourceLanguage: toShortLanguageCode(source),
    targetLanguage: toShortLanguageCode(target)
  };
}

export type OnDeviceFailureReason =
  /** This browser cannot translate the pair on the device at all. */
  | "unsupported"
  /** Chrome will set the model up only inside a click or key press on this page. */
  | "needs-activation"
  /** The model exists but did not answer this string. */
  | "failed";

export class OnDeviceTranslatorError extends Error {
  constructor(
    readonly reason: OnDeviceFailureReason,
    message: string
  ) {
    super(message);
    this.name = "OnDeviceTranslatorError";
  }
}

const AVAILABILITY_TIMEOUT_MS = 10_000;
/** One paragraph. A model that takes longer than this is not going to answer. */
const TRANSLATE_TIMEOUT_MS = 20_000;

/**
 * On-device translators into one target language, one per source language.
 *
 * Unlike the caption draft channel, a page cannot quietly go without: when
 * Chrome refuses to create a translator until the user acts, the refusal is
 * reported as `needs-activation`, and `activate()` — called from the user's
 * click — asks again.
 */
export class OnDeviceTranslatorPool {
  private readonly ready = new Map<LanguageTag, TranslatorInstance>();
  private readonly pending = new Map<LanguageTag, Promise<TranslatorInstance>>();
  /** Sources Chrome refused because the page had no user activation. */
  private readonly blocked = new Set<LanguageTag>();
  private destroyed = false;

  constructor(
    readonly target: LanguageTag,
    /** Model download progress, 0–1, while Chrome fetches a language pack. */
    private readonly onDownloadProgress?: (fraction: number) => void
  ) {}

  /** Whether some translation is waiting for the user to click once. */
  needsActivation(): boolean {
    return this.blocked.size > 0;
  }

  async translate(text: string, source: LanguageTag): Promise<string> {
    const translator = await this.translatorFor(source, true);
    const result = await withTimeout(translator.translate(text), TRANSLATE_TIMEOUT_MS);
    if (typeof result !== "string") {
      throw new OnDeviceTranslatorError("failed", "Chrome 本地翻译没有在限定时间内返回译文。");
    }
    return result;
  }

  /**
   * Asks again for every translator Chrome refused. Call it synchronously
   * from a click or key handler: the activation it needs belongs to that
   * event, so nothing is awaited before `create()` is called.
   */
  async activate(sources: LanguageTag[] = []): Promise<boolean> {
    const wanted = new Set([...this.blocked, ...sources]);
    this.blocked.clear();
    const results = await Promise.all(
      [...wanted].map((source) =>
        this.translatorFor(source, false).then(
          () => true,
          () => false
        )
      )
    );
    return results.every(Boolean);
  }

  destroy(): void {
    this.destroyed = true;
    for (const instance of this.ready.values()) {
      instance.destroy?.();
    }
    this.ready.clear();
    this.pending.clear();
    this.blocked.clear();
  }

  private translatorFor(source: LanguageTag, probe: boolean): Promise<TranslatorInstance> {
    const ready = this.ready.get(source);
    if (ready) {
      return Promise.resolve(ready);
    }
    const inFlight = this.pending.get(source);
    if (inFlight) {
      return inFlight;
    }
    const creating = this.create(source, probe);
    this.pending.set(source, creating);
    const forget = () => {
      if (this.pending.get(source) === creating) {
        this.pending.delete(source);
      }
    };
    creating.then(forget, forget);
    return creating;
  }

  private async create(source: LanguageTag, probe: boolean): Promise<TranslatorInstance> {
    const factory = readTranslatorFactory();
    if (!factory) {
      throw new OnDeviceTranslatorError(
        "unsupported",
        "这个 Chrome 没有内置翻译接口（Translator API，需要 Chrome 138 或更新版本）。"
      );
    }
    const pair = translatorPair(source, this.target);
    if (probe) {
      // Skipped when activating: the click's activation only lasts a moment,
      // and a slow probe must not spend it before `create()` is called.
      const availability = await withTimeout(factory.availability(pair), AVAILABILITY_TIMEOUT_MS);
      if (availability === null || availability === "unavailable") {
        throw new OnDeviceTranslatorError(
          "unsupported",
          `这台设备上的 Chrome 不支持用内置模型翻译 ${pair.sourceLanguage} → ${pair.targetLanguage}。`
        );
      }
    }
    let instance: TranslatorInstance;
    try {
      instance = await factory.create({
        ...pair,
        monitor: (monitor) => {
          monitor.addEventListener("downloadprogress", (event) => {
            const loaded = (event as { loaded?: unknown }).loaded;
            if (typeof loaded === "number" && Number.isFinite(loaded)) {
              this.onDownloadProgress?.(Math.min(1, Math.max(0, loaded)));
            }
          });
        }
      });
    } catch (error) {
      if ((error as { name?: unknown })?.name === "NotAllowedError") {
        this.blocked.add(source);
        throw new OnDeviceTranslatorError(
          "needs-activation",
          "Chrome 需要你在页面上点一下，才能在这个网站启用本地翻译模型。"
        );
      }
      throw new OnDeviceTranslatorError(
        "unsupported",
        `Chrome 无法启用 ${pair.sourceLanguage} → ${pair.targetLanguage} 的本地翻译模型。`
      );
    }
    if (this.destroyed) {
      instance.destroy?.();
      throw new OnDeviceTranslatorError("failed", "本地翻译已停止。");
    }
    this.ready.set(source, instance);
    return instance;
  }
}
