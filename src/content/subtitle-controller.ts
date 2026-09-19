import type { ExtensionMessage } from "../shared/messages";
import { safeRuntimeSendMessage } from "../shared/extension-context";
import { isCueWithinPlaybackWindow } from "../shared/subtitle";
import {
  shouldReplaceCaption,
  type CaptionStage,
  type PublicTranslationSettings,
  type RuntimeStatus,
  type SubtitleCue,
  type SubtitleSource,
  type TranslationResponse
} from "../shared/types";
import { TextTrackAdapter } from "./adapters/text-track-adapter";
import type { SubtitleAdapter, SubtitleAdapterEvent } from "./adapters/types";
import { YouTubeCaptionAdapter } from "./adapters/youtube-caption-adapter";
import { NetflixCaptionAdapter } from "./adapters/netflix-caption-adapter";
import { createDraftChannel, type DraftChannel } from "./fast-translator";
import { SubtitleOverlay } from "./overlay";

/**
 * A translation always lands after the caption it belongs to, so ending both at
 * the same moment leaves the viewer less time to read the Chinese than the
 * source line was on screen for. Hold the translation briefly past the end of
 * its cue; a newer caption still replaces it immediately.
 *
 * Measured in media time so the hold follows the video: it does not expire
 * while paused, and it shortens correctly at higher playback speeds.
 */
const MIN_TRANSLATION_VISIBLE_MEDIA_MS = 900;
/** Cap local text→translation memory so a long watch session cannot grow forever. */
const MAX_LOCAL_TEXT_CACHE = 200;
/** Skip near-duplicate streaming paints that would make the caption shimmer. */
const STREAM_THROTTLE_MS = 40;
const STREAM_MIN_CHAR_DELTA = 2;
/**
 * Netflix often grows one on-screen line across several DOM writes. Wait for a
 * quiet window so we translate the settled Japanese once instead of aborting
 * and rewriting Chinese on every partial.
 */
const NETFLIX_REVISE_DEBOUNCE_MS = 100;
/** First streamed paint needs at least this many characters to avoid flashing a lone glyph. */
const NETFLIX_EARLY_STREAM_MIN_CHARS = 2;

export class SubtitleController {
  readonly sessionId = `tranlithion:${location.pathname}:${crypto.randomUUID()}`;

  private settings: PublicTranslationSettings;
  private readonly overlay: SubtitleOverlay;
  private readonly adapters: SubtitleAdapter[];
  private readonly youtubeAdapter: YouTubeCaptionAdapter | null;
  private readonly netflixAdapter: NetflixCaptionAdapter | null;
  private readonly availability = new Map<SubtitleSource, boolean>();
  private activeSource: SubtitleSource | null = null;
  private activeCue: SubtitleCue | null = null;
  private activeCueStage: CaptionStage = "none";
  private draftTranslator: DraftChannel | null = null;
  private draftAbort: AbortController | null = null;
  private captionShownAtMediaMs = 0;
  private teardownTimer: number | null = null;
  private destroyed = false;
  /** Instant Netflix hits without waiting for the background round-trip. */
  private readonly localTextCache = new Map<string, string>();
  private lastStreamPaintAt = 0;
  private lastStreamText = "";
  private reviseTimer: number | null = null;
  private pendingReviseCue: SubtitleCue | null = null;

  constructor(
    readonly video: HTMLVideoElement,
    settings: PublicTranslationSettings,
    private readonly requestTranslation: (cue: SubtitleCue) => Promise<TranslationResponse>,
    private readonly reportStatus: (status: RuntimeStatus) => void
  ) {
    this.settings = settings;
    this.overlay = new SubtitleOverlay(video, settings);
    this.youtubeAdapter = isYouTubePage() ? new YouTubeCaptionAdapter(video) : null;
    this.netflixAdapter = isNetflixPage() ? new NetflixCaptionAdapter(video) : null;
    // Netflix must not share the page with TextTrack: a hidden track can steal
    // activeSource and hide the sticky overlay mid-cue.
    this.adapters = [
      ...(this.netflixAdapter ? [] : [new TextTrackAdapter(video, settings.sourceLanguage)]),
      ...(this.youtubeAdapter ? [this.youtubeAdapter] : []),
      ...(this.netflixAdapter ? [this.netflixAdapter] : [])
    ];
  }

  start(): void {
    this.youtubeAdapter?.setNativeCaptionVisibility(!this.settings.enabled);
    this.syncNetflixNativeVisibility();
    this.syncDraftTranslator();
    this.report("searching", "正在寻找可读取的日文文本字幕");
    for (const adapter of this.adapters) {
      adapter.start((event) => this.handleAdapterEvent(event));
    }
    if (!this.settings.enabled) {
      this.report("idle", "翻译已暂停");
    }
  }

  updateSettings(settings: PublicTranslationSettings): void {
    const previous = this.settings;
    this.settings = settings;
    this.youtubeAdapter?.setNativeCaptionVisibility(!settings.enabled);
    this.syncNetflixNativeVisibility();
    this.overlay.updateSettings(settings);
    if (
      settings.draftCaptions !== previous.draftCaptions ||
      settings.draftProvider !== previous.draftProvider ||
      settings.draftApiKeyConfigured !== previous.draftApiKeyConfigured ||
      settings.sourceLanguage !== previous.sourceLanguage
    ) {
      this.syncDraftTranslator();
    }
    if (!settings.enabled) {
      this.overlay.hide();
      this.report("idle", "翻译已暂停");
    } else if (!this.activeCue) {
      this.report("searching", "正在等待日文文本字幕");
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.cancelTeardown();
    this.cancelReviseDebounce();
    this.draftAbort?.abort();
    this.draftAbort = null;
    this.draftTranslator?.destroy();
    this.draftTranslator = null;
    for (const adapter of this.adapters) {
      adapter.stop();
    }
    this.overlay.destroy();
    void safeRuntimeSendMessage({
      type: "CLEAR_TRANSLATION_SESSION",
      sessionId: this.sessionId
    } satisfies ExtensionMessage);
  }

  showPartialTranslation(sessionId: string, cueId: string, text: string): void {
    if (
      sessionId !== this.sessionId ||
      !this.settings.enabled ||
      this.activeCue?.id !== cueId ||
      this.activeCue.source !== "netflix-dom" ||
      !text.trim()
    ) {
      return;
    }
    // Early stream only while nothing is on screen yet. If DeepL draft already
    // painted, ignore tokens so the caption is not rewritten mid-line; final
    // may still replace draft once when the main model finishes.
    if (this.activeCueStage !== "none") {
      return;
    }
    const trimmed = text.trim();
    if (trimmed.length < NETFLIX_EARLY_STREAM_MIN_CHARS) {
      return;
    }
    this.applyCaption(this.activeCue, "streaming", trimmed);
  }

  private handleAdapterEvent(event: SubtitleAdapterEvent): void {
    if (this.destroyed) {
      return;
    }
    if (event.type === "availability") {
      this.availability.set(event.source, event.available);
      this.handleAvailabilityChange(event);
      return;
    }
    if (event.type === "cue-start") {
      this.handleCueStart(event.cue);
      return;
    }
    if (event.type === "cue-revise") {
      this.handleCueRevise(event.cue, event.previousCueId);
      return;
    }
    this.handleCueEnd(event.source, event.cueId);
  }

  private handleAvailabilityChange(event: Extract<SubtitleAdapterEvent, { type: "availability" }>): void {
    if (!event.available && this.activeSource === event.source && !this.activeCue) {
      this.activeSource = null;
    }
    if (!this.settings.enabled || this.activeCue) {
      return;
    }
    if ([...this.availability.values()].some(Boolean)) {
      this.report("ready", "字幕源已就绪，正在等待下一句");
    } else {
      this.report("unavailable", "未检测到可读取的字幕；请先在播放器中开启日文字幕");
    }
  }

  private handleCueStart(cue: SubtitleCue): void {
    if (!this.settings.enabled) {
      return;
    }
    if (!this.acceptSource(cue.source)) {
      return;
    }
    if (this.activeCue?.id === cue.id) {
      return;
    }

    // A newer caption always wins over the previous one's reading-time hold.
    this.cancelTeardown();
    this.cancelReviseDebounce();
    this.activeCue = cue;
    this.activeCueStage = "none";
    this.lastStreamPaintAt = 0;
    this.lastStreamText = "";
    this.draftAbort?.abort();
    this.draftAbort = new AbortController();

    if (cue.source === "netflix-dom") {
      // Sticky overlay: never flash Japanese back, never blank the Chinese line.
      // A local text hit paints immediately; otherwise the previous Chinese stays.
      this.syncNetflixNativeVisibility();
      const cached = this.localTextCache.get(cue.text);
      if (cached) {
        this.applyCaption(cue, "final", cached);
        this.report("ready", "正在同步显示中文译文", cue.source, 0);
        // Still refresh the background session / text cache for context memory.
        void this.translateActiveCue(cue);
        return;
      }
      this.report("translating", "正在翻译当前字幕", cue.source);
      if (this.usesDeepLOnly()) {
        // Skip DeepSeek entirely: DeepL is the sole on-screen translator for Netflix.
        void this.translateWithDeepLOnly(cue, this.draftAbort.signal);
        return;
      }
      // DeepL draft + DeepSeek final when DeepL-only is not configured.
      void this.showDraftTranslation(cue, this.draftAbort.signal);
      void this.translateActiveCue(cue);
      return;
    }

    this.overlay.show({
      translation: "正在翻译…",
      original: cue.text,
      pending: true
    });
    this.report("translating", "正在翻译当前字幕", cue.source);
    // Both channels start together. The local draft normally lands within tens
    // of milliseconds; the service answer replaces it whenever it arrives.
    void this.showDraftTranslation(cue, this.draftAbort.signal);
    void this.translateActiveCue(cue);
  }

  /**
   * Same on-screen Netflix slot, new Japanese text. Keep the current Chinese
   * frozen and only retranslate after the DOM stops churning.
   */
  private handleCueRevise(cue: SubtitleCue, previousCueId: string): void {
    if (!this.settings.enabled) {
      return;
    }
    if (!this.acceptSource(cue.source)) {
      return;
    }
    if (this.activeCue?.id !== previousCueId && this.activeCue?.id !== cue.id) {
      // Orphan revise after teardown; treat as a fresh start.
      this.handleCueStart(cue);
      return;
    }

    this.cancelTeardown();
    // Point activeCue at the new id immediately so stale streams/results for the
    // previous id cannot paint. Do not reset stage or hide—freeze the Chinese
    // already on screen until the debounced translate lands.
    this.activeCue = cue;
    this.syncNetflixNativeVisibility();

    const cached = this.localTextCache.get(cue.text);
    if (cached) {
      this.cancelReviseDebounce();
      this.activeCueStage = "none";
      this.applyCaption(cue, "final", cached);
      this.report("ready", "正在同步显示中文译文", cue.source, 0);
      void this.translateActiveCue(cue);
      return;
    }

    this.pendingReviseCue = cue;
    if (this.reviseTimer !== null) {
      window.clearTimeout(this.reviseTimer);
    }
    this.reviseTimer = window.setTimeout(() => {
      this.reviseTimer = null;
      this.flushPendingRevise();
    }, NETFLIX_REVISE_DEBOUNCE_MS);
  }

  private flushPendingRevise(): void {
    const cue = this.pendingReviseCue;
    this.pendingReviseCue = null;
    if (this.destroyed || !cue || this.activeCue?.id !== cue.id || !this.settings.enabled) {
      return;
    }

    const cached = this.localTextCache.get(cue.text);
    if (cached) {
      this.activeCueStage = "none";
      this.applyCaption(cue, "final", cached);
      this.report("ready", "正在同步显示中文译文", cue.source, 0);
      void this.translateActiveCue(cue);
      return;
    }

    // Allow the settled translation to replace the frozen sticky line once.
    this.activeCueStage = "none";
    this.lastStreamPaintAt = 0;
    this.lastStreamText = "";
    this.draftAbort?.abort();
    this.draftAbort = new AbortController();
    this.report("translating", "正在翻译当前字幕", cue.source);
    if (this.usesDeepLOnly()) {
      void this.translateWithDeepLOnly(cue, this.draftAbort.signal);
      return;
    }
    void this.showDraftTranslation(cue, this.draftAbort.signal);
    void this.translateActiveCue(cue);
  }

  private cancelReviseDebounce(): void {
    if (this.reviseTimer !== null) {
      window.clearTimeout(this.reviseTimer);
      this.reviseTimer = null;
    }
    this.pendingReviseCue = null;
  }

  private handleCueEnd(source: SubtitleSource, cueId: string): void {
    if (source !== this.activeSource || cueId !== this.activeCue?.id) {
      return;
    }
    // A real end beats a pending revise for the same slot.
    this.cancelReviseDebounce();
    // Nothing is on screen yet when no channel has answered, so there is no
    // reading time to protect and the cue can end immediately.
    const shownForMediaMs = this.video.currentTime * 1_000 - this.captionShownAtMediaMs;
    let readingTimeLeft =
      this.activeCueStage === "none"
        ? 0
        : MIN_TRANSLATION_VISIBLE_MEDIA_MS - shownForMediaMs;
    // Netflix sticky Chinese often outlives stage=none (waiting on a late
    // translation). Clearing on delay 0 blanks the overlay and looks like the
    // line "ended instantly."
    if (
      source === "netflix-dom" &&
      this.overlay.isShowing() &&
      readingTimeLeft <= 0
    ) {
      readingTimeLeft = MIN_TRANSLATION_VISIBLE_MEDIA_MS;
    }
    // Always defer teardown. Netflix emits cue-end then cue-start/revise in the
    // same turn when the line changes; a synchronous hide() would blank the
    // sticky Chinese overlay before the next handler can cancel this timer.
    const rate = this.video.playbackRate > 0 ? this.video.playbackRate : 1;
    const delayMs = readingTimeLeft > 0 ? readingTimeLeft / rate : 0;
    this.scheduleTeardown(source, delayMs);
  }

  private scheduleTeardown(source: SubtitleSource, delayMs: number): void {
    this.cancelTeardown();
    this.teardownTimer = window.setTimeout(() => {
      this.teardownTimer = null;
      this.teardownCue(source);
    }, delayMs);
  }

  private cancelTeardown(): void {
    if (this.teardownTimer !== null) {
      window.clearTimeout(this.teardownTimer);
      this.teardownTimer = null;
    }
  }

  private teardownCue(source: SubtitleSource): void {
    this.cancelTeardown();
    this.cancelReviseDebounce();
    this.draftAbort?.abort();
    this.draftAbort = null;
    this.activeCue = null;
    this.activeCueStage = "none";
    this.overlay.hide();
    if (source === "netflix-dom") {
      // Keep native captions suppressed for the whole enabled session.
      this.syncNetflixNativeVisibility();
    }
    if (this.settings.enabled) {
      this.report("ready", "正在等待下一句字幕", source);
    }
  }

  private acceptSource(source: SubtitleSource): boolean {
    if (source === "text-track") {
      if (this.activeSource !== "text-track") {
        this.activeSource = "text-track";
        this.activeCue = null;
        this.overlay.hide();
      }
      return true;
    }
    if (!this.activeSource) {
      this.activeSource = source;
    }
    return this.activeSource === source;
  }

  /** Netflix: DeepL alone when the draft channel is configured for DeepL. */
  private usesDeepLOnly(): boolean {
    return (
      this.settings.draftCaptions &&
      this.settings.draftProvider === "deepl" &&
      this.settings.draftApiKeyConfigured
    );
  }

  /**
   * DeepL is the only network hop. Result is painted as final (no underline,
   * no later DeepSeek rewrite).
   */
  private async translateWithDeepLOnly(cue: SubtitleCue, signal: AbortSignal): Promise<void> {
    try {
      const startedAt = performance.now();
      const translator = this.draftTranslator;
      if (!translator || !this.settings.enabled) {
        this.report("error", "DeepL 未就绪；请在选项中开启草稿并填写 API Key。", cue.source);
        return;
      }
      const text = await translator.translate(cue.text, signal);
      if (signal.aborted || this.destroyed || this.activeCue?.id !== cue.id) {
        return;
      }
      if (!text) {
        this.report("error", "DeepL 翻译失败或超时。", cue.source);
        return;
      }
      this.rememberLocalTranslation(cue.text, text);
      this.applyCaption(cue, "final", text);
      this.report(
        "ready",
        "正在同步显示中文译文（DeepL）",
        cue.source,
        Math.round(performance.now() - startedAt)
      );
    } catch {
      // Extension reload / aborted network: never surface as uncaught rejection.
    }
  }

  private async showDraftTranslation(cue: SubtitleCue, signal: AbortSignal): Promise<void> {
    try {
      const translator = this.draftTranslator;
      if (!translator || !this.settings.enabled) {
        return;
      }
      const draft = await translator.translate(cue.text, signal);
      if (!draft || signal.aborted) {
        return;
      }
      this.applyCaption(cue, "draft", draft);
    } catch {
      // Draft is best-effort.
    }
  }

  /**
   * Single write path for caption text. Stages only ever move forward, so a
   * slow draft that resolves after the service answer cannot regress the
   * caption to lower-quality text.
   */
  private applyCaption(cue: SubtitleCue, stage: CaptionStage, text: string): boolean {
    if (this.destroyed || this.activeCue?.id !== cue.id) {
      return false;
    }
    // Streaming may refine the same stage in place; other stages stay monotonic.
    const refiningStream = stage === "streaming" && this.activeCueStage === "streaming";
    if (!refiningStream && !shouldReplaceCaption(this.activeCueStage, stage)) {
      return false;
    }
    // Reading time is measured from the first text shown, not from each
    // upgrade, so a late final translation cannot extend the hold indefinitely.
    if (this.activeCueStage === "none") {
      this.captionShownAtMediaMs = this.video.currentTime * 1_000;
    }
    this.activeCueStage = stage;
    if (stage === "streaming") {
      this.lastStreamPaintAt = performance.now();
      this.lastStreamText = text;
    }
    this.overlay.show({
      translation: text,
      original: cue.text,
      pending: stage === "streaming",
      draft: stage === "draft"
    });
    return true;
  }

  private shouldPaintStreaming(text: string): boolean {
    if (this.activeCueStage !== "streaming" && this.activeCueStage !== "draft" && this.activeCueStage !== "none") {
      // Already at final; ignore late stream chunks.
      return false;
    }
    if (this.activeCueStage !== "streaming") {
      return true;
    }
    const now = performance.now();
    const elapsed = now - this.lastStreamPaintAt;
    const grew = text.length - this.lastStreamText.length;
    return elapsed >= STREAM_THROTTLE_MS || grew >= STREAM_MIN_CHAR_DELTA;
  }

  private syncNetflixNativeVisibility(): void {
    // While translation is on, Japanese stays hidden for the whole Netflix
    // session so cue boundaries cannot flash the source line back on screen.
    this.netflixAdapter?.setNativeCaptionVisibility(!this.settings.enabled);
  }

  private rememberLocalTranslation(sourceText: string, translation: string): void {
    const key = sourceText.trim();
    const value = translation.trim();
    if (!key || !value) {
      return;
    }
    this.localTextCache.delete(key);
    this.localTextCache.set(key, value);
    while (this.localTextCache.size > MAX_LOCAL_TEXT_CACHE) {
      const oldest = this.localTextCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.localTextCache.delete(oldest);
    }
  }

  private syncDraftTranslator(): void {
    this.draftTranslator?.destroy();
    this.draftTranslator = createDraftChannel(
      this.settings,
      this.sessionId,
      () => this.activeCue?.id ?? ""
    );
    // Warm the channel now so the first caption does not pay a one-time model
    // download. An unsupported pair simply disables the channel.
    void this.draftTranslator?.prepare();
  }

  private async translateActiveCue(cue: SubtitleCue): Promise<void> {
    try {
      const response = await this.requestTranslation(cue);
      if (this.destroyed || this.activeCue?.id !== cue.id) {
        return;
      }
      if (!isCueWithinPlaybackWindow(cue, this.video.currentTime * 1_000)) {
        return;
      }
      if (!response.ok || !response.translation) {
        const message = response.error?.message ?? "翻译服务暂时不可用。";
        // A local draft is a usable translation. Replacing it with an error would
        // throw away readable text the viewer is already following.
        if (this.activeCueStage === "draft" || this.activeCueStage === "streaming") {
          this.report("error", `${message}（当前显示可用译文）`, cue.source);
          return;
        }
        if (cue.source === "netflix-dom") {
          // Keep the sticky Chinese line if one is already showing from a prior cue.
          if (this.activeCueStage === "none" && !this.overlayHasVisibleTranslation()) {
            this.overlay.hide();
          }
          this.syncNetflixNativeVisibility();
        } else {
          this.overlay.show({
            translation: "翻译服务不可用",
            original: cue.text,
            forceOriginal: true
          });
        }
        this.report("error", message, cue.source);
        return;
      }

      this.rememberLocalTranslation(cue.text, response.translation.text);
      this.applyCaption(cue, "final", response.translation.text);
      const mode = response.translation.provider === "mock" ? "演示翻译模式" : "正在同步显示中文译文";
      this.report("ready", mode, cue.source, response.translation.latencyMs);
    } catch {
      // Background gone after extension reload.
    }
  }

  private overlayHasVisibleTranslation(): boolean {
    // Overlay does not expose internals; stage none means nothing Chinese was
    // painted for this cue. Prior-cue text may still be on screen because we
    // deliberately skipped hide() on Netflix cue-start.
    return this.overlay.isShowing();
  }

  private report(
    state: RuntimeStatus["state"],
    message: string,
    source = this.activeSource ?? undefined,
    latencyMs?: number
  ): void {
    this.reportStatus({ state, message, source, latencyMs, updatedAt: Date.now() });
  }
}

function isYouTubePage(): boolean {
  return /(^|\.)youtube\.com$/.test(location.hostname) || /(^|\.)youtube-nocookie\.com$/.test(location.hostname);
}

function isNetflixPage(): boolean {
  return location.hostname === "netflix.com" || location.hostname === "www.netflix.com";
}
