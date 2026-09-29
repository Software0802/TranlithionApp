import type {
  DraftTranslationResponse,
  ExtensionMessage,
  PlainTranslationResponse
} from "../shared/messages";
import { safeRuntimeSendMessage } from "../shared/extension-context";
import { toShortLanguageCode } from "../shared/language";
import { MEETING_FINAL_CHANNEL_TIMEOUT_MS } from "../shared/meeting";
import { applyTerminology } from "../shared/terminology";
import type {
  GlossaryEntry,
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
 * Input that gives the page transient user activation. The Translator API
 * reports every pair as `downloadable` to a site until that site has created a
 * translator for it, and creating one then needs user activation — which a
 * caption turning up on its own never has. The viewer's next click or key
 * press on the player is the first moment the local model can be set up.
 */
const ACTIVATION_EVENTS = ["pointerdown", "pointerup", "keydown"] as const;
/** Creation failing for some other reason must not retry on every click forever. */
const MAX_CREATE_ATTEMPTS = 5;

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
  /**
   * The channel is not broken but waiting for the viewer to click or press a
   * key on the page, which is what the browser needs before it can be set up.
   */
  awaitingActivation?(): boolean;
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

/** Where the page's input events can be heard; absent outside a document. */
function activationTarget(): Pick<EventTarget, "addEventListener" | "removeEventListener"> | null {
  const target = (globalThis as { window?: unknown }).window ?? globalThis;
  return typeof (target as EventTarget).addEventListener === "function"
    ? (target as EventTarget)
    : null;
}

/** False only when the browser says outright that the page has no activation now. */
function mayHaveUserActivation(): boolean {
  const navigatorLike = (globalThis as {
    navigator?: { userActivation?: { isActive?: unknown } };
  }).navigator;
  const isActive = navigatorLike?.userActivation?.isActive;
  return typeof isActive === "boolean" ? isActive : true;
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
  /** The one availability probe and first creation attempt this channel makes. */
  private preparation: Promise<void> | null = null;
  private unsupported = false;
  private destroyed = false;
  private factory: TranslatorFactory | null = null;
  /**
   * A `create()` still running. It is kept past any caller's wait: a model
   * download can take longer than a caption stays on screen, and the
   * translator it finally yields serves every caption after it.
   */
  private creating: Promise<TranslatorInstance | null> | null = null;
  private createAttempts = 0;
  private stopWaitingForActivation: (() => void) | null = null;

  constructor(
    sourceLanguage: SourceLanguage,
    targetLanguage: TargetLanguage,
    /** This channel is the caption the user reads, not a preview of one. */
    private readonly asFinal = false,
    /**
     * The user's fixed renderings. Chrome's on-device translator takes no
     * glossary and runs here rather than in the worker, so this is the only
     * place they can be applied to its output. Read at call time: a glossary
     * edited during a call takes effect on the next line.
     */
    private readonly terminology: () => GlossaryEntry[] = () => []
  ) {
    this.pair = {
      sourceLanguage: toTranslatorLanguage(sourceLanguage),
      targetLanguage: toTranslatorLanguage(targetLanguage)
    };
  }

  /**
   * Warms the local model so the first caption does not pay the download cost.
   * Resolves to false while no translator exists: when this browser cannot
   * serve the configured pair, or while a pair that still has to be
   * downloaded waits for the viewer's first click or key press on the page.
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
        this.asFinal ? MEETING_FINAL_CHANNEL_TIMEOUT_MS : DRAFT_TIMEOUT_MS
      );
      if (signal?.aborted || typeof translated !== "string") {
        return null;
      }
      const trimmed = translated.trim();
      if (!trimmed) {
        return null;
      }
      if (!this.asFinal) {
        // As a draft, an echo of the source is worse than showing nothing: it
        // would look like a finished translation that failed to translate,
        // and the real one is still on its way.
        return trimmed !== source ? trimmed : null;
      }
      // As the caption itself there is nothing behind it — a name or a figure
      // simply reads the same in both languages, and calling that a dead
      // channel would be a lie.
      return applyTerminology(trimmed, this.terminology());
    } catch {
      return null;
    }
  }

  awaitingActivation(): boolean {
    return !this.instance && !this.destroyed && this.stopWaitingForActivation !== null;
  }

  destroy(): void {
    this.destroyed = true;
    this.stopWaitingForActivation?.();
    this.stopWaitingForActivation = null;
    this.instance?.destroy?.();
    this.instance = null;
    this.preparation = null;
  }

  /**
   * Waits for the first preparation only. After that a caption never waits on
   * the local model: until a translator exists the channel answers null at
   * once, and the model's answer serves the caption as it did before.
   */
  private async resolveInstance(): Promise<TranslatorInstance | null> {
    if (this.instance || this.unsupported || this.destroyed) {
      return this.instance;
    }
    this.preparation ??= this.probe().catch(() => {
      this.unsupported = true;
    });
    await this.preparation;
    return this.instance;
  }

  private async probe(): Promise<void> {
    const factory = readTranslatorFactory();
    if (!factory) {
      this.unsupported = true;
      return;
    }
    const availability: TranslatorAvailability | null = await withTimeout(
      factory.availability(this.pair),
      PREPARE_TIMEOUT_MS
    );
    // A null here means the probe timed out or threw; treat it the same as an
    // explicit "unavailable" so the channel disables itself instead of retrying
    // a hanging call on every caption.
    if (availability === null || availability === "unavailable") {
      this.unsupported = true;
      return;
    }
    this.factory = factory;
    await withTimeout(this.startCreating(), PREPARE_TIMEOUT_MS);
  }

  /**
   * Asks for a translator. A pair that is already on the device needs nothing
   * more; one that still has to be downloaded is refused until the page has
   * user activation, so a refusal waits for the viewer's next click or key
   * press and asks again from inside it.
   */
  private startCreating(): Promise<TranslatorInstance | null> {
    const factory = this.factory;
    if (this.creating || !factory || this.destroyed) {
      return this.creating ?? Promise.resolve(null);
    }
    this.createAttempts += 1;
    const creating: Promise<TranslatorInstance | null> = Promise.resolve()
      .then(() => factory.create(this.pair))
      .then(
        (instance) => {
          if (this.destroyed) {
            instance.destroy?.();
            return null;
          }
          this.instance = instance;
          return instance;
        },
        () => {
          this.waitForActivation();
          return null;
        }
      )
      .finally(() => {
        if (this.creating === creating) {
          this.creating = null;
        }
      });
    this.creating = creating;
    return creating;
  }

  private waitForActivation(): void {
    if (
      this.destroyed ||
      this.instance ||
      this.stopWaitingForActivation ||
      this.createAttempts >= MAX_CREATE_ATTEMPTS
    ) {
      return;
    }
    const target = activationTarget();
    if (!target) {
      return;
    }
    const onInput = () => {
      // A touch's pointerdown carries no activation yet; its pointerup will.
      if (!mayHaveUserActivation()) {
        return;
      }
      stop();
      void this.startCreating();
    };
    const stop = () => {
      for (const type of ACTIVATION_EVENTS) {
        target.removeEventListener(type, onInput, { capture: true });
      }
      if (this.stopWaitingForActivation === stop) {
        this.stopWaitingForActivation = null;
      }
    };
    for (const type of ACTIVATION_EVENTS) {
      // Capture on the window hears the click before a player can stop it.
      target.addEventListener(type, onInput, { capture: true, passive: true });
    }
    this.stopWaitingForActivation = stop;
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
    /**
     * This channel is the caption itself — a meeting's channel, or DeepL alone
     * on Netflix — so it gets a final caption's budget rather than a draft's.
     */
    private readonly asFinal = false,
    /** The lines are a call's, which a withdrawn record consent must reach. */
    private readonly meeting = false
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
        asFinal: this.asFinal,
        meeting: this.meeting
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
  constructor(private readonly sessionId: string) {}

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
          text,
          sessionId: this.sessionId
        } satisfies ExtensionMessage),
        MEETING_FINAL_CHANNEL_TIMEOUT_MS
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
  asFinal = false,
  terminology: () => GlossaryEntry[] = () => [],
  meeting = false
): DraftChannel | null {
  if (settings.draftProvider === "browser") {
    return new DraftTranslator(
      settings.sourceLanguage,
      settings.targetLanguage,
      asFinal,
      terminology
    );
  }
  // A remote provider without a key would spend a request per caption to fail.
  if (settings.draftProvider === "deepl" && !settings.draftApiKeyConfigured) {
    return null;
  }
  return new RemoteDraftTranslator(sessionId, cueIdOf, asFinal, meeting);
}
