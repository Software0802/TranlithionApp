import type { ExtensionMessage } from "../shared/messages";
import { safeRuntimeSendMessage } from "../shared/extension-context";
import { languageLabel } from "../shared/language";
import { isMeetingModeActive } from "../shared/meeting";
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
import { MediaClock, WallClock, type ClockSource } from "./clock";
import { TextTrackAdapter } from "./adapters/text-track-adapter";
import type { SubtitleAdapter, SubtitleAdapterEvent } from "./adapters/types";
import { YouTubeCaptionAdapter } from "./adapters/youtube-caption-adapter";
import { NetflixCaptionAdapter } from "./adapters/netflix-caption-adapter";
import { MeetCaptionAdapter } from "./adapters/meet-caption-adapter";
import { createDraftChannel, createFastChannel, LocalMtTranslator, type DraftChannel } from "./fast-translator";
import { SubtitleOverlay } from "./overlay";

/**
 * What the captions are attached to.
 *
 * A film page has one video that owns both the timeline and the overlay's
 * position. A meeting page has neither: Meet renders many small tiles, none of
 * which tracks the conversation, so the controller runs on the wall clock and
 * the overlay spans the viewport.
 */
export type CaptionTarget =
  | { kind: "video"; video: HTMLVideoElement }
  | { kind: "page" };

/**
 * A translation always lands after the caption it belongs to, so ending both at
 * the same moment leaves the viewer less time to read the translation than the
 * source line was on screen for. Hold the translation briefly past the end of
 * its cue; a newer caption still replaces it immediately.
 *
 * Measured on the controller's clock, so on a video it follows playback: it
 * does not expire while paused and shortens correctly at higher speeds.
 */
const MIN_TRANSLATION_VISIBLE_MS = 900;
/** Cap local text→translation memory so a long session cannot grow forever. */
const MAX_LOCAL_TEXT_CACHE = 200;
/** Skip near-duplicate streaming paints that would make the caption shimmer. */
const STREAM_THROTTLE_MS = 40;
const STREAM_MIN_CHAR_DELTA = 2;
/**
 * Netflix often grows one on-screen line across several DOM writes. Wait for a
 * quiet window so we translate the settled source once instead of aborting and
 * rewriting the translation on every partial.
 */
const NETFLIX_REVISE_DEBOUNCE_MS = 100;
/**
 * Speech recognition rewrites a meeting line far more often than a player
 * repaints a subtitle — every few hundred milliseconds, including corrections
 * to words already shown. A longer quiet window is what keeps one spoken
 * sentence to roughly one translation request.
 */
const MEETING_REVISE_DEBOUNCE_MS = 400;
/** First streamed paint needs at least this many characters to avoid flashing a lone glyph. */
const EARLY_STREAM_MIN_CHARS = 2;

/** How long to wait for a source to settle before retranslating it. */
export function reviseDebounceMs(source: SubtitleSource): number {
  return source === "meet-dom" ? MEETING_REVISE_DEBOUNCE_MS : NETFLIX_REVISE_DEBOUNCE_MS;
}

/**
 * Sources whose captions replace each other in place. The overlay never blanks
 * between two of their cues: the previous translation stays until the next one
 * is ready, because both a Netflix repaint and a recognizer revision would
 * otherwise flicker the caption several times a second.
 */
export function isStickySource(source: SubtitleSource): boolean {
  return source === "netflix-dom" || source === "meet-dom";
}

export class SubtitleController {
  readonly sessionId = `tranlithion:${location.pathname}:${crypto.randomUUID()}`;

  private settings: PublicTranslationSettings;
  private readonly clock: ClockSource;
  private readonly overlay: SubtitleOverlay;
  private readonly adapters: SubtitleAdapter[];
  private readonly youtubeAdapter: YouTubeCaptionAdapter | null;
  private readonly netflixAdapter: NetflixCaptionAdapter | null;
  private readonly meetAdapter: MeetCaptionAdapter | null;
  private readonly availability = new Map<SubtitleSource, boolean>();
  private activeSource: SubtitleSource | null = null;
  private activeCue: SubtitleCue | null = null;
  private activeCueStage: CaptionStage = "none";
  private draftTranslator: DraftChannel | null = null;
  /** Meeting mode's single low-cost channel; null when the model is the final. */
  private meetingChannel: DraftChannel | null = null;
  private draftAbort: AbortController | null = null;
  private captionShownAtMs = 0;
  private teardownTimer: number | null = null;
  private destroyed = false;
  /** Instant repeats without waiting for the background round-trip. */
  private readonly localTextCache = new Map<string, string>();
  private lastStreamPaintAt = 0;
  private lastStreamText = "";
  private reviseTimer: number | null = null;
  private pendingReviseCue: SubtitleCue | null = null;

  constructor(
    readonly target: CaptionTarget,
    settings: PublicTranslationSettings,
    private readonly requestTranslation: (cue: SubtitleCue) => Promise<TranslationResponse>,
    private readonly reportStatus: (status: RuntimeStatus) => void
  ) {
    this.settings = settings;
    this.clock = target.kind === "video" ? new MediaClock(target.video) : new WallClock();
    this.overlay = new SubtitleOverlay(
      target.kind === "video" ? target.video : null,
      settings
    );

    const video = target.kind === "video" ? target.video : null;
    this.meetAdapter = this.meetingMode() ? new MeetCaptionAdapter(this.clock) : null;
    this.youtubeAdapter = video && isYouTubePage() ? new YouTubeCaptionAdapter(video) : null;
    this.netflixAdapter = video && isNetflixPage() ? new NetflixCaptionAdapter(video) : null;
    // Netflix and Meet must not share the page with TextTrack: a hidden track
    // can steal activeSource and hide the sticky overlay mid-cue.
    const allowTextTrack = Boolean(video) && !this.netflixAdapter && !this.meetAdapter;
    this.adapters = [
      ...(allowTextTrack && video ? [new TextTrackAdapter(video, settings.sourceLanguage)] : []),
      ...(this.youtubeAdapter ? [this.youtubeAdapter] : []),
      ...(this.netflixAdapter ? [this.netflixAdapter] : []),
      ...(this.meetAdapter ? [this.meetAdapter] : [])
    ];
  }

  start(): void {
    this.youtubeAdapter?.setNativeCaptionVisibility(!this.settings.enabled);
    this.syncNativeCaptionVisibility();
    this.syncTranslationChannels();
    this.report("searching", this.searchingMessage());
    for (const adapter of this.adapters) {
      adapter.start((event) => this.handleAdapterEvent(event));
    }
    if (!this.settings.enabled) {
      this.report("idle", "翻译已暂停");
    } else if (this.overlayHidden()) {
      this.report("idle", "会议模式：译文已隐藏（共享屏幕用）");
    }
  }

  updateSettings(settings: PublicTranslationSettings): void {
    const previous = this.settings;
    this.settings = settings;
    this.youtubeAdapter?.setNativeCaptionVisibility(!settings.enabled);
    this.syncNativeCaptionVisibility();
    this.overlay.updateSettings(settings);
    if (
      settings.draftCaptions !== previous.draftCaptions ||
      settings.draftProvider !== previous.draftProvider ||
      settings.draftApiKeyConfigured !== previous.draftApiKeyConfigured ||
      settings.sourceLanguage !== previous.sourceLanguage ||
      settings.targetLanguage !== previous.targetLanguage ||
      settings.meetingFinalChannel !== previous.meetingFinalChannel
    ) {
      this.syncTranslationChannels();
    }
    if (
      settings.sourceLanguage !== previous.sourceLanguage ||
      settings.targetLanguage !== previous.targetLanguage
    ) {
      // Cached text is keyed by source text alone, so it is wrong for the new pair.
      this.localTextCache.clear();
    }
    if (!settings.enabled) {
      this.overlay.hide();
      this.report("idle", "翻译已暂停");
    } else if (this.overlayHidden()) {
      this.overlay.hide();
      this.report("idle", "会议模式：译文已隐藏（共享屏幕用）");
    } else if (!this.activeCue) {
      this.report("searching", this.searchingMessage());
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
    this.meetingChannel?.destroy();
    this.meetingChannel = null;
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
      this.overlayHidden() ||
      this.activeCue?.id !== cueId ||
      !isStickySource(this.activeCue.source) ||
      !text.trim()
    ) {
      return;
    }
    // Early stream only while nothing is on screen yet. If a draft already
    // painted, ignore tokens so the caption is not rewritten mid-line; final
    // may still replace draft once when the main model finishes.
    if (this.activeCueStage !== "none") {
      return;
    }
    const trimmed = text.trim();
    if (trimmed.length < EARLY_STREAM_MIN_CHARS) {
      return;
    }
    this.applyCaption(this.activeCue, "streaming", trimmed);
  }

  private meetingMode(): boolean {
    return isMeetingModeActive(this.settings, location.hostname);
  }

  /** Screen-share escape hatch: nothing is drawn and nothing is translated. */
  private overlayHidden(): boolean {
    return this.meetingMode() && this.settings.meetingOverlayHidden;
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
    if (!this.settings.enabled || this.overlayHidden() || this.activeCue) {
      return;
    }
    if ([...this.availability.values()].some(Boolean)) {
      this.report("ready", "字幕源已就绪，正在等待下一句");
    } else {
      this.report("unavailable", this.unavailableMessage());
    }
  }

  private handleCueStart(cue: SubtitleCue): void {
    if (!this.settings.enabled || this.overlayHidden()) {
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

    if (isStickySource(cue.source)) {
      // Sticky overlay: never flash the source language back, never blank the
      // translation. A local text hit paints immediately; otherwise the
      // previous translation stays until this one is ready.
      this.syncNativeCaptionVisibility();
      const cached = this.localTextCache.get(cue.text);
      if (cached) {
        this.applyCaption(cue, "final", cached);
        this.report("ready", "正在同步显示译文", cue.source, 0);
        this.refreshSessionContext(cue);
        return;
      }
      if (this.reportMissingMeetingChannel(cue.source)) {
        return;
      }
      this.report("translating", "正在翻译当前字幕", cue.source);
      const single = this.singleChannel();
      if (single) {
        // One network hop only: the fast channel is the caption the user reads.
        void this.translateWithSingleChannel(cue, single, this.draftAbort.signal);
        return;
      }
      // Fast draft + model final when no single channel is configured.
      void this.showDraftTranslation(cue, this.draftAbort.signal);
      void this.translateActiveCue(cue);
      return;
    }

    this.overlay.show({
      translation: "正在翻译…",
      original: cue.text,
      speaker: cue.speaker,
      pending: true
    });
    this.report("translating", "正在翻译当前字幕", cue.source);
    // Both channels start together. The local draft normally lands within tens
    // of milliseconds; the service answer replaces it whenever it arrives.
    void this.showDraftTranslation(cue, this.draftAbort.signal);
    void this.translateActiveCue(cue);
  }

  /**
   * Same on-screen slot, new source text. Keep the current translation frozen
   * and only retranslate after the DOM stops churning.
   */
  private handleCueRevise(cue: SubtitleCue, previousCueId: string): void {
    if (!this.settings.enabled || this.overlayHidden()) {
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
    // previous id cannot paint. Do not reset stage or hide—freeze the text
    // already on screen until the debounced translate lands.
    this.activeCue = cue;
    this.syncNativeCaptionVisibility();

    const cached = this.localTextCache.get(cue.text);
    if (cached) {
      this.cancelReviseDebounce();
      this.activeCueStage = "none";
      this.applyCaption(cue, "final", cached);
      this.report("ready", "正在同步显示译文", cue.source, 0);
      this.refreshSessionContext(cue);
      return;
    }

    this.pendingReviseCue = cue;
    if (this.reviseTimer !== null) {
      window.clearTimeout(this.reviseTimer);
    }
    this.reviseTimer = window.setTimeout(() => {
      this.reviseTimer = null;
      this.flushPendingRevise();
    }, reviseDebounceMs(cue.source));
  }

  private flushPendingRevise(): void {
    const cue = this.pendingReviseCue;
    this.pendingReviseCue = null;
    if (
      this.destroyed ||
      !cue ||
      this.activeCue?.id !== cue.id ||
      !this.settings.enabled ||
      this.overlayHidden()
    ) {
      return;
    }

    const cached = this.localTextCache.get(cue.text);
    if (cached) {
      this.activeCueStage = "none";
      this.applyCaption(cue, "final", cached);
      this.report("ready", "正在同步显示译文", cue.source, 0);
      this.refreshSessionContext(cue);
      return;
    }

    // Allow the settled translation to replace the frozen sticky line once.
    this.activeCueStage = "none";
    this.lastStreamPaintAt = 0;
    this.lastStreamText = "";
    this.draftAbort?.abort();
    this.draftAbort = new AbortController();
    if (this.reportMissingMeetingChannel(cue.source)) {
      return;
    }
    this.report("translating", "正在翻译当前字幕", cue.source);
    const single = this.singleChannel();
    if (single) {
      void this.translateWithSingleChannel(cue, single, this.draftAbort.signal);
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
    const shownForMs = this.clock.nowMs() - this.captionShownAtMs;
    let readingTimeLeft =
      this.activeCueStage === "none" ? 0 : MIN_TRANSLATION_VISIBLE_MS - shownForMs;
    // A sticky translation often outlives stage=none (waiting on a late
    // answer). Clearing on delay 0 blanks the overlay and looks like the line
    // "ended instantly."
    if (isStickySource(source) && this.overlay.isShowing() && readingTimeLeft <= 0) {
      readingTimeLeft = MIN_TRANSLATION_VISIBLE_MS;
    }
    // Always defer teardown. A sticky source emits cue-end then cue-start or
    // cue-revise in the same turn when the line changes; a synchronous hide()
    // would blank the overlay before the next handler can cancel this timer.
    const delayMs = readingTimeLeft > 0 ? readingTimeLeft / this.clock.rate() : 0;
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
    if (isStickySource(source)) {
      // Keep the site's own captions suppressed for the whole enabled session.
      this.syncNativeCaptionVisibility();
    }
    if (this.settings.enabled && !this.overlayHidden()) {
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

  /**
   * The channel that alone produces the caption the user reads, or null when
   * the chat model is the final translator.
   *
   * Meetings default here: an hour of talk is several times an episode's line
   * count, and a machine-translation hop is both cheaper and fast enough to
   * keep up with speech.
   */
  private singleChannel(): DraftChannel | null {
    if (this.meetingMode()) {
      return this.meetingChannel;
    }
    return this.usesDeepLOnly() ? this.draftTranslator : null;
  }

  /**
   * Says so plainly when meeting mode is pointed at a machine-translation
   * channel the user has not finished configuring.
   *
   * Quietly falling back to the chat model would translate an hour of meeting
   * on the expensive path the user explicitly opted out of, so nothing is
   * translated until the channel is fixed. Returns true when it reported.
   */
  private reportMissingMeetingChannel(source: SubtitleSource): boolean {
    if (!this.meetingMode() || this.settings.meetingFinalChannel === "llm" || this.meetingChannel) {
      return false;
    }
    this.report(
      "error",
      "会议翻译通道尚未配置：请在设置中填写 DeepL / 自定义机器翻译的地址与 Key，或改用本机 LibreTranslate。",
      source
    );
    return true;
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
   * One network hop. The result is painted as final (no underline, no later
   * rewrite by the chat model).
   */
  private async translateWithSingleChannel(
    cue: SubtitleCue,
    channel: DraftChannel,
    signal: AbortSignal
  ): Promise<void> {
    try {
      const startedAt = performance.now();
      if (!this.settings.enabled) {
        return;
      }
      const text = await channel.translate(cue.text, signal);
      if (signal.aborted || this.destroyed || this.activeCue?.id !== cue.id) {
        return;
      }
      if (!text) {
        this.report("error", this.singleChannelFailureMessage(), cue.source);
        return;
      }
      this.rememberLocalTranslation(cue.text, text);
      this.applyCaption(cue, "final", text);
      this.report(
        "ready",
        `正在同步显示译文（${this.singleChannelLabel()}）`,
        cue.source,
        Math.round(performance.now() - startedAt)
      );
    } catch {
      // Extension reload / aborted network: never surface as uncaught rejection.
    }
  }

  private singleChannelLabel(): string {
    if (!this.meetingMode()) {
      return "DeepL";
    }
    if (this.settings.meetingFinalChannel === "local-mt") {
      return "本机 LibreTranslate";
    }
    return this.settings.draftProvider === "deepl" ? "DeepL" : "机器翻译";
  }

  private singleChannelFailureMessage(): string {
    if (this.meetingMode() && this.settings.meetingFinalChannel === "local-mt") {
      return "本机 LibreTranslate 未响应；请确认它已启动，或在设置中改用其他会议翻译通道。";
    }
    return `${this.singleChannelLabel()}：翻译失败或超时；请在设置中检查该通道的地址与 Key。`;
  }

  /**
   * Refreshes the background session's context and text cache after a caption
   * was served from local memory.
   *
   * Skipped whenever a single low-cost channel is the final translator: the
   * chat model never renders those captions, so a request here would spend a
   * model call purely to fill a context window nothing reads.
   */
  private refreshSessionContext(cue: SubtitleCue): void {
    if (this.singleChannel()) {
      return;
    }
    void this.translateActiveCue(cue);
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
    if (this.destroyed || this.activeCue?.id !== cue.id || this.overlayHidden()) {
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
      this.captionShownAtMs = this.clock.nowMs();
    }
    this.activeCueStage = stage;
    if (stage === "streaming") {
      this.lastStreamPaintAt = performance.now();
      this.lastStreamText = text;
    }
    this.overlay.show({
      translation: text,
      original: cue.text,
      speaker: cue.speaker,
      pending: stage === "streaming",
      draft: stage === "draft"
    });
    if (stage === "final") {
      this.recordMeetingLine(cue, text);
    }
    return true;
  }

  /**
   * D7: hand the settled bilingual line to the background worker, which owns
   * both the retention-limited transcript and the session's term memory. Only
   * meeting captions are recorded, and only while the user has the transcript
   * switched on.
   */
  private recordMeetingLine(cue: SubtitleCue, translation: string): void {
    if (cue.source !== "meet-dom" || !this.meetingMode()) {
      return;
    }
    void safeRuntimeSendMessage({
      type: "RECORD_MEETING_LINE",
      sessionId: this.sessionId,
      host: location.hostname,
      title: document.title,
      cue,
      translation
    } satisfies ExtensionMessage);
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

  /**
   * While the translation is on, the site's own captions stay hidden for the
   * whole session so cue boundaries cannot flash the source line back on
   * screen. Hiding the overlay for a screen share brings them straight back.
   */
  private syncNativeCaptionVisibility(): void {
    const nativeVisible = !this.settings.enabled || this.overlayHidden();
    this.netflixAdapter?.setNativeCaptionVisibility(nativeVisible);
    this.meetAdapter?.setNativeCaptionVisibility(nativeVisible);
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

  private syncTranslationChannels(): void {
    this.draftTranslator?.destroy();
    this.draftTranslator = null;
    this.meetingChannel?.destroy();
    this.meetingChannel = null;

    if (this.meetingMode() && this.settings.meetingFinalChannel !== "llm") {
      this.meetingChannel =
        this.settings.meetingFinalChannel === "local-mt"
          ? new LocalMtTranslator()
          : createFastChannel(this.settings, this.sessionId, () => this.activeCue?.id ?? "", true);
      void this.meetingChannel?.prepare();
      return;
    }

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
      if (!isCueWithinPlaybackWindow(cue, this.clock.nowMs())) {
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
        if (isStickySource(cue.source)) {
          // Keep the sticky line if one is already showing from a prior cue.
          if (this.activeCueStage === "none" && !this.overlayHasVisibleTranslation()) {
            this.overlay.hide();
          }
          this.syncNativeCaptionVisibility();
        } else {
          this.overlay.show({
            translation: "翻译服务不可用",
            original: cue.text,
            speaker: cue.speaker,
            forceOriginal: true
          });
        }
        this.report("error", message, cue.source);
        return;
      }

      this.rememberLocalTranslation(cue.text, response.translation.text);
      this.applyCaption(cue, "final", response.translation.text);
      const mode = response.translation.provider === "mock" ? "演示翻译模式" : "正在同步显示译文";
      this.report("ready", mode, cue.source, response.translation.latencyMs);
    } catch {
      // Background gone after extension reload.
    }
  }

  private overlayHasVisibleTranslation(): boolean {
    // Overlay does not expose internals; stage none means nothing was painted
    // for this cue. Prior-cue text may still be on screen because we
    // deliberately skipped hide() on a sticky cue-start.
    return this.overlay.isShowing();
  }

  private searchingMessage(): string {
    return this.meetAdapter
      ? "正在等待 Google Meet 字幕"
      : `正在寻找可读取的${languageLabel(this.settings.sourceLanguage)}文本字幕`;
  }

  private unavailableMessage(): string {
    return this.meetAdapter
      ? "未检测到 Meet 字幕；请在 Meet 底部工具栏点击「开启字幕」(CC)。"
      : `未检测到可读取的字幕；请先在播放器中开启${languageLabel(this.settings.sourceLanguage)}字幕`;
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
