import type { ExtensionMessage } from "../shared/messages";
import { safeRuntimeSendMessage } from "../shared/extension-context";
import { languageLabel } from "../shared/language";
import { isMeetingModeActive, meetingLineBudgetMs } from "../shared/meeting";
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
/** The same for the meeting lines already shown; only the recent ones matter. */
const MAX_PAINTED_CUE_IDS = 200;
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
/**
 * A prefetched line or a local draft answers within a frame or two. Showing
 * 「正在翻译…」 before it would flash the placeholder once per line, so it only
 * goes up once the wait is long enough to notice.
 */
const PENDING_PLACEHOLDER_DELAY_MS = 150;
/** How many upcoming text-track lines are translated ahead of playback. */
const PREFETCH_AHEAD_CUES = 3;

/** How long to wait for a source to settle before translating it. */
export function reviseDebounceMs(source: SubtitleSource): number {
  return source === "meet-dom" ? MEETING_REVISE_DEBOUNCE_MS : NETFLIX_REVISE_DEBOUNCE_MS;
}

/** What one meeting sentence is allowed to spend, and what came of it. */
interface MeetingLineBudget {
  controller: AbortController;
  deadlineAt: number;
  answered: boolean;
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
  private readonly textTrackAdapter: TextTrackAdapter | null;
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
  /**
   * DeepL alone on Netflix. Its answer is the caption itself, with nothing
   * behind it, so it runs as a final channel rather than as a draft.
   */
  private filmFinalChannel: DraftChannel | null = null;
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
  private placeholderTimer: number | null = null;
  /** The translation services' connections were opened for this page. */
  private warmedUp = false;
  /** Meeting translations, one at a time. See `runFinalTranslation`. */
  private meetingQueue: Promise<void> = Promise.resolve();
  /** Aborted on destroy only: a finished sentence outlives its on-screen slot. */
  private readonly settleAbort = new AbortController();
  /** The meeting's only channel answered with nothing. */
  private meetingChannelBroken = false;
  /** Settled cues already handed to the transcript, so each is recorded once. */
  private readonly recordedCueIds = new Set<string>();
  /** The pair the answer currently streaming in was asked for. */
  private streamingPair: string | null = null;
  /** The last line that reached the overlay, newer than which nothing older paints. */
  private lastPaintedCue: SubtitleCue | null = null;
  /**
   * Meeting lines the user has already read, so a late answer cannot replay
   * one. A streamed partial is not one of them: it is the blank being filled
   * while the sentence is still being written, and the answer it is standing
   * in for has not been seen yet.
   */
  private readonly paintedCueIds = new Set<string>();
  /** One budget per sentence, keyed by its cue. See `runFinalTranslation`. */
  private readonly meetingLineBudgets = new Map<string, MeetingLineBudget>();

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
    this.textTrackAdapter =
      allowTextTrack && video ? new TextTrackAdapter(video, settings.sourceLanguage) : null;
    this.adapters = [
      ...(this.textTrackAdapter ? [this.textTrackAdapter] : []),
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
    if (this.target.kind === "video") {
      this.target.video.addEventListener("play", this.handlePlay);
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
    if (settings.sourceLanguage !== previous.sourceLanguage) {
      // The track was picked for the language the user just left; reading on
      // from it would hand one language's subtitles to a translator asked
      // for another's.
      this.textTrackAdapter?.setSourceLanguage(settings.sourceLanguage);
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
    this.meetingLineBudgets.clear();
    this.cancelTeardown();
    this.cancelReviseDebounce();
    this.cancelPendingPlaceholder();
    this.draftAbort?.abort();
    this.draftAbort = null;
    this.settleAbort.abort();
    this.draftTranslator?.destroy();
    this.draftTranslator = null;
    this.meetingChannel?.destroy();
    this.meetingChannel = null;
    this.filmFinalChannel?.destroy();
    this.filmFinalChannel = null;
    if (this.target.kind === "video") {
      this.target.video.removeEventListener("play", this.handlePlay);
    }
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
      // Tokens of an answer the user switched languages away from mid-stream.
      this.streamingPair !== this.languagePair() ||
      !text.trim()
    ) {
      return;
    }
    // A draft on screen is a whole sentence already, and the model's first
    // tokens would only shorten what the viewer is reading: the finished
    // answer replaces it once. Otherwise the answer is painted as it streams
    // in, so the line fills in as it is written instead of at its end.
    if (this.activeCueStage !== "none" && this.activeCueStage !== "streaming") {
      return;
    }
    const trimmed = text.trim();
    if (this.activeCueStage === "none" && trimmed.length < EARLY_STREAM_MIN_CHARS) {
      return;
    }
    if (!this.shouldPaintStreaming(trimmed)) {
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
    if (event.available && this.settings.enabled && !this.overlayHidden()) {
      this.warmUpTranslationServices(event.source);
      if (event.source === "text-track") {
        // The first lines are asked for before playback reaches them too.
        this.prefetchUpcoming(null);
      }
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
    this.cancelPendingPlaceholder();
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
      if (cue.source === "meet-dom") {
        // A recognizer opens a turn with a word or two that the next read
        // rewrites. Translating that costs a request per sentence for text
        // nobody finishes reading, so the first fragment waits with the rest:
        // it is translated once it stops growing, or when it settles.
        this.scheduleSettledTranslation(cue);
        return;
      }
      this.startFinalTranslation(cue, this.draftAbort.signal);
      return;
    }

    this.schedulePendingPlaceholder(cue);
    this.report("translating", "正在翻译当前字幕", cue.source);
    // Both channels start together. The local draft normally lands within tens
    // of milliseconds; the service answer replaces it whenever it arrives.
    void this.showDraftTranslation(cue, this.draftAbort.signal);
    void this.translateActiveCue(cue);
    if (cue.source === "text-track") {
      this.prefetchUpcoming(cue);
    }
  }

  /** 「正在翻译…」 for a line whose translation has not arrived in time to skip it. */
  private schedulePendingPlaceholder(cue: SubtitleCue): void {
    this.cancelPendingPlaceholder();
    this.placeholderTimer = window.setTimeout(() => {
      this.placeholderTimer = null;
      if (
        this.destroyed ||
        this.activeCue?.id !== cue.id ||
        this.activeCueStage !== "none" ||
        !this.settings.enabled ||
        this.overlayHidden()
      ) {
        return;
      }
      this.overlay.show({
        translation: "正在翻译…",
        original: cue.text,
        speaker: cue.speaker,
        pending: true
      });
    }, PENDING_PLACEHOLDER_DELAY_MS);
  }

  private cancelPendingPlaceholder(): void {
    if (this.placeholderTimer !== null) {
      window.clearTimeout(this.placeholderTimer);
      this.placeholderTimer = null;
    }
  }

  /**
   * A text track carries the lines still to come, so the next few are
   * translated before they are due and each is waiting in the background's
   * cache when it comes on screen. Captions a page renders itself cannot be
   * known before they are shown, and are translated as they appear.
   *
   * The line on screen leads the list. A prefetch already working on it is
   * then kept for the caption asking for it, however the two messages
   * interleave, instead of being dropped as a line the viewer moved past.
   */
  private prefetchUpcoming(onScreen: SubtitleCue | null): void {
    const track = this.textTrackAdapter;
    if (
      !track ||
      !this.settings.enabled ||
      (this.activeSource !== null && this.activeSource !== "text-track")
    ) {
      return;
    }
    const upcoming = track.upcomingCues(
      onScreen?.startMs ?? this.clock.nowMs(),
      PREFETCH_AHEAD_CUES
    );
    const cues = onScreen
      ? [onScreen, ...upcoming.filter((cue) => cue.id !== onScreen.id)]
      : upcoming;
    if (cues.length === 0) {
      return;
    }
    void safeRuntimeSendMessage({
      type: "PREFETCH_CUES",
      sessionId: this.sessionId,
      cues
    } satisfies ExtensionMessage);
  }

  /**
   * Opens the connections this page's captions will use once captions show
   * up, so the first line does not pay the connection setup. Only services
   * this page actually sends lines to: a meeting on a machine-translation
   * channel never touches the chat model, not even with an empty request.
   */
  private warmUpTranslationServices(source: SubtitleSource): void {
    if (this.warmedUp) {
      return;
    }
    this.warmedUp = true;
    const meeting = this.meetingMode();
    const channel = this.settings.meetingFinalChannel;
    const model = meeting
      ? channel === "llm"
      : !(isStickySource(source) && this.usesDeepLOnly());
    const draft =
      this.settings.draftProvider !== "browser" &&
      (meeting
        ? channel === "fast-mt" || (channel === "llm" && this.settings.draftCaptions)
        : this.settings.draftCaptions);
    if (!model && !draft) {
      return;
    }
    void safeRuntimeSendMessage({
      type: "WARM_UP_TRANSLATOR",
      model,
      draft
    } satisfies ExtensionMessage);
  }

  /**
   * Same on-screen slot, new source text. Keep the current translation frozen
   * and only retranslate after the DOM stops churning.
   */
  private handleCueRevise(cue: SubtitleCue, previousCueId: string): void {
    // The wording this replaces is gone, and so is whatever budget it was
    // running on. A recognizer that rewrites a line and then corrects itself
    // back rebuilds the same cue id, and that line is being asked for now,
    // not whenever the abandoned wording first went out. True however the
    // overlay stands: the hide switch decides what is translated and shown,
    // not whether the controller's own bookkeeping stays straight.
    this.meetingLineBudgets.delete(previousCueId);
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

    this.scheduleSettledTranslation(cue);
  }

  /** Translates this line once the source has stopped rewriting it. */
  private scheduleSettledTranslation(cue: SubtitleCue): void {
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
    this.startFinalTranslation(cue, this.draftAbort.signal);
  }

  /**
   * Starts whatever produces the caption the user reads: one machine
   * translation hop when a single channel is configured, otherwise a local
   * draft plus the model's answer.
   */
  private startFinalTranslation(cue: SubtitleCue, signal: AbortSignal): void {
    const single = this.singleChannel();
    if (single) {
      // One network hop only: the fast channel is the caption the user reads.
      this.runFinalTranslation(
        (lineSignal) =>
          this.translateWithSingleChannel(cue, single, untilEither(signal, lineSignal)),
        cue
      );
      return;
    }
    // Fast draft + model final when no single channel is configured.
    void this.showDraftTranslation(cue, signal);
    this.runFinalTranslation((lineSignal) => this.translateActiveCue(cue, lineSignal), cue);
  }

  /**
   * Meeting captions translate one at a time.
   *
   * Both the background's draft channel and its job queue keep only the newest
   * request per session, so two overlapping meeting requests cancel the older
   * one — and in a meeting the older one is usually a sentence that has just
   * finished and still has to reach the screen and the transcript. Speech
   * arrives a sentence at a time, so queuing costs far less than losing a line.
   *
   * A queued job asks again whether it may run. Pausing or hiding the overlay
   * for a screen share stops meeting text from leaving the page, and a line
   * that was waiting its turn when the user hit the switch has not been sent
   * yet, so it is dropped rather than translated a second later.
   *
   * The budget belongs to the sentence, not to the job. A sentence reaches
   * the queue twice — once when it stops growing and again when its cue ends
   * and it has to be recorded — and it gets one deadline, set when it first
   * joined the queue, so waiting its turn ages it exactly as much as a slow
   * channel does. One line may cost itself, never the whole conversation, and
   * a line already given up on is not asked for a second time.
   *
   * What the budget bounds is waiting on a channel, not how long a cue stays
   * open: a speaker can hold a finished sentence on screen for a minute, and
   * the translation that came back in time still owes the transcript its row.
   *
   * A job that owns no caption — a context refresh behind a line already on
   * screen — is abandoned in silence: nothing was skipped that the user can
   * see, so saying otherwise would be a lie told over a good translation.
   */
  private runFinalTranslation(
    job: (signal?: AbortSignal) => Promise<void>,
    line?: SubtitleCue
  ): void {
    if (!this.meetingMode()) {
      void job();
      return;
    }
    const budgetMs = meetingLineBudgetMs(this.settings.meetingFinalChannel);
    const budget = this.meetingLineBudget(line, budgetMs);
    const run = async () => {
      if (this.destroyed || !this.settings.enabled || this.overlayHidden()) {
        return;
      }
      if (budget.controller.signal.aborted) {
        return;
      }
      if (line && this.localTextCache.has(line.text)) {
        await job().catch(() => undefined);
        return;
      }
      if (budget.answered) {
        return;
      }
      const remainingMs = budget.deadlineAt - this.clock.nowMs();
      if (remainingMs <= 0) {
        this.expireMeetingLine(budget.controller, budgetMs, line);
        return;
      }
      const budgetTimer = window.setTimeout(
        () => this.expireMeetingLine(budget.controller, budgetMs, line),
        remainingMs
      );
      try {
        await Promise.race([
          job(budget.controller.signal).catch(() => undefined),
          whenAborted(budget.controller.signal)
        ]);
      } finally {
        window.clearTimeout(budgetTimer);
      }
      budget.answered = !budget.controller.signal.aborted;
    };
    this.meetingQueue = this.meetingQueue.then(run, run).catch(() => undefined);
  }

  /**
   * The one deadline this sentence gets, however often it reaches the queue,
   * and what became of it.
   *
   * `answered` is what the channel said — a translation or a refusal the user
   * was already told about. Either way the line's outcome is settled, so a
   * later job for it neither asks again nor lets the deadline it no longer
   * needs contradict the answer the user has.
   */
  private meetingLineBudget(line: SubtitleCue | undefined, budgetMs: number): MeetingLineBudget {
    const known = line ? this.meetingLineBudgets.get(line.id) : undefined;
    if (known) {
      return known;
    }
    const budget: MeetingLineBudget = {
      controller: new AbortController(),
      deadlineAt: this.clock.nowMs() + budgetMs,
      answered: false
    };
    if (line) {
      this.meetingLineBudgets.set(line.id, budget);
    }
    return budget;
  }

  /**
   * Gives up on a line that ran out of budget, and says so once.
   *
   * Only once, and only when the user has nothing to read for it: a line the
   * channel answered in time still owes the transcript its row, and a line
   * already showing a draft is on screen and readable — putting Meet's own
   * strip back over it and calling it skipped would contradict what the user
   * is looking at.
   */
  private expireMeetingLine(
    controller: AbortController,
    budgetMs: number,
    line?: SubtitleCue
  ): void {
    if (controller.signal.aborted || this.destroyed) {
      return;
    }
    if (line && this.localTextCache.has(line.text)) {
      return;
    }
    controller.abort();
    if (!line || !this.settings.enabled || this.overlayHidden()) {
      return;
    }
    if (this.activeCue?.id === line.id && this.activeCueStage !== "none") {
      return;
    }
    this.setMeetingChannelBroken(true);
    this.report("error", this.meetingBudgetMessage(budgetMs), "meet-dom");
  }

  private meetingBudgetMessage(budgetMs: number): string {
    const label =
      this.settings.meetingFinalChannel === "llm" ? "大模型" : this.singleChannelLabel();
    return `${label}：这一句 ${Math.round(budgetMs / 1000)} 秒内没有答复，已跳过，以免后面的句子跟着堵住。`;
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
    this.settleMeetingLine(this.activeCue);
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
    this.cancelPendingPlaceholder();
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
    return this.usesDeepLOnly() ? this.filmFinalChannel : null;
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
    this.setMeetingChannelBroken(true);
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
      const pair = this.languagePair();
      const text = await channel.translate(cue.text, signal);
      if (this.destroyed || pair !== this.languagePair()) {
        return;
      }
      if (text) {
        // Cached by source text before the freshness check: a sentence the
        // next line has already replaced on screen still owes the transcript
        // its translation.
        this.rememberLocalTranslation(cue.text, text);
      }
      if (signal.aborted) {
        // Superseded, or answered after this line ran out of budget: the user
        // has already been told it was skipped, so it changes nothing now.
        return;
      }
      if (text) {
        this.setMeetingChannelBroken(false);
      }
      if (!text) {
        // A channel that cannot answer is a fact about the channel, not about
        // the cue that happened to ask: the strip comes back and the user is
        // told even when the line is long gone from the screen.
        this.setMeetingChannelBroken(true);
        if (this.activeCue?.id !== cue.id && !this.meetingMode()) {
          return;
        }
        this.report("error", this.singleChannelFailureMessage(), cue.source);
        return;
      }
      const painted = this.applyCaption(cue, "final", text);
      if (!painted && this.activeCue?.id !== cue.id) {
        this.reportUnshownLine(cue);
        return;
      }
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
    if (this.settings.draftProvider === "browser") {
      return "Chrome 内置翻译";
    }
    return this.settings.draftProvider === "deepl" ? "DeepL" : "机器翻译";
  }

  private singleChannelFailureMessage(): string {
    if (this.meetingMode() && this.settings.meetingFinalChannel === "local-mt") {
      return "本机 LibreTranslate 未响应；请确认它已启动，或在设置中改用其他会议翻译通道。";
    }
    // The on-device translator has neither an address nor a Key, so sending
    // the user to check them would be pointing at the wrong screen.
    if (this.meetingMode() && this.settings.draftProvider === "browser") {
      // Nothing is wrong with the configuration: Chrome is waiting for the
      // one click that lets this site set the language pair up.
      if (this.meetingChannel?.awaitingActivation?.()) {
        return "Chrome 内置翻译还没启用：在这个网站第一次使用这个语言对时，Chrome 要等你在会议页面上点击或按键一次。点一下页面后，下一句就会翻译。";
      }
      return "Chrome 内置翻译没有给出结果：这台设备或这个语言对可能不支持它。请在设置中把会议翻译通道改为 DeepL / 自定义机器翻译或本机 LibreTranslate。";
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
   *
   * It takes its turn in the meeting queue like every other meeting request.
   * The background keeps only the newest request per meeting session, so a
   * refresh sent while a settled sentence is still being translated would
   * cancel that sentence — and this line is already on screen, while that one
   * still owes the user a caption and the transcript a line.
   */
  private refreshSessionContext(cue: SubtitleCue): void {
    if (this.singleChannel()) {
      return;
    }
    this.runFinalTranslation((signal) => this.translateActiveCue(cue, signal));
  }

  private async showDraftTranslation(cue: SubtitleCue, signal: AbortSignal): Promise<void> {
    try {
      const translator = this.draftTranslator;
      if (!translator || !this.settings.enabled) {
        return;
      }
      const pair = this.languagePair();
      const draft = await translator.translate(cue.text, signal);
      if (!draft || signal.aborted || pair !== this.languagePair()) {
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
    if (this.destroyed || this.overlayHidden()) {
      return false;
    }
    const superseded = this.activeCue?.id !== cue.id;
    if (superseded && !this.paintsAheadOfActiveCue(cue, stage)) {
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
    if (!superseded) {
      // The stage belongs to the cue that is open, and this text came from an
      // older one: whatever the open cue produces still gets its turn.
      this.activeCueStage = stage;
    }
    if (stage === "streaming") {
      this.lastStreamPaintAt = performance.now();
      this.lastStreamText = text;
    }
    this.lastPaintedCue = cue;
    if (cue.source === "meet-dom" && stage !== "streaming") {
      this.rememberPaintedCue(cue.id);
    }
    this.overlay.show({
      translation: text,
      original: cue.text,
      speaker: cue.speaker,
      pending: stage === "streaming",
      draft: stage === "draft"
    });
    if (superseded && !this.activeCue) {
      // The cue this belongs to is over and nothing has taken the slot, so
      // the sticky overlay is holding it alone: give it the same reading
      // time any other line gets rather than leaving it up until the next.
      this.scheduleTeardown(cue.source, MIN_TRANSLATION_VISIBLE_MS);
    }
    return true;
  }

  /**
   * Whether a sentence that has already ended may still go up.
   *
   * A recognizer punctuates the line it just finished together with the first
   * words of the next one, so a meeting sentence is settled — and only then
   * translated — when the cue after it is already the active one, or when the
   * turn is over and no cue is open at all. Either way its translation is the
   * newest text anyone has, and the sticky overlay exists to hold exactly
   * that. Once something newer has painted — or this sentence itself has
   * already had its turn on screen — it never comes back over what follows.
   */
  private paintsAheadOfActiveCue(cue: SubtitleCue, stage: CaptionStage): boolean {
    if (cue.source !== "meet-dom" || stage !== "final") {
      return false;
    }
    if (!this.activeCue) {
      if (this.paintedCueIds.has(cue.id)) {
        return false;
      }
      return !this.lastPaintedCue || this.lastPaintedCue.startMs <= cue.startMs;
    }
    return this.activeCueStage === "none";
  }

  /**
   * A line that was translated but never reached the screen, because the
   * meeting had already moved on to a sentence the user is reading now.
   * Silently dropping it would leave them with a transcript row for a line
   * they never saw and no idea why.
   *
   * Only that one cause is worth saying, and only once it is the cause that
   * actually applies: a line held back because the user hid the overlay, one
   * they already read before its own translation came back around, or one
   * dropped while the screen is blank anyway was not lost to the next
   * sentence, and claiming so would describe a meeting that did not happen.
   */
  private reportUnshownLine(cue: SubtitleCue): void {
    if (cue.source !== "meet-dom" || !this.meetingMode()) {
      return;
    }
    if (this.overlayHidden() || !this.settings.enabled || this.paintedCueIds.has(cue.id)) {
      return;
    }
    if (!this.activeCue || !this.overlay.isShowing()) {
      return;
    }
    this.report(
      "ready",
      "这一句的译文回来时屏幕上已经是下一句了，没有再顶掉它。",
      cue.source
    );
  }

  /**
   * A meeting sentence is settled when its cue ends, and only a settled
   * sentence belongs in the transcript: painting happens on every debounced
   * revision, so recording there would keep "Good", "Good morning", "Good
   * morning everyone" as three lines of one sentence.
   *
   * The translation is still wanted even when the next sentence has already
   * taken the slot, so the request in flight for this line is detached from
   * the active cue's abort and the recording waits for it on the meeting
   * queue.
   */
  private settleMeetingLine(cue: SubtitleCue | null): void {
    if (!cue || cue.source !== "meet-dom" || !this.meetingMode()) {
      return;
    }
    if (this.settings.enabled && !this.overlayHidden()) {
      // Whatever is translating this sentence must survive the next cue-start.
      this.draftAbort = null;
      this.runFinalTranslation(async (signal) => {
        if (!this.localTextCache.has(cue.text)) {
          await this.translateSettledLine(cue, signal);
        }
        if (signal?.aborted) {
          return;
        }
        const translation = this.localTextCache.get(cue.text);
        if (translation) {
          this.recordMeetingLine(cue, translation);
        }
      }, cue);
    }
    // The cue is over, so that was the last job it can ask for — and the job
    // already holds its budget. Dropping the entry keeps a long call from
    // collecting one per sentence, and keeps a cue id the recognizer happens
    // to recreate from inheriting a deadline that has nothing to do with it.
    this.meetingLineBudgets.delete(cue.id);
  }

  private async translateSettledLine(cue: SubtitleCue, signal?: AbortSignal): Promise<void> {
    if (this.destroyed || !this.settings.enabled) {
      return;
    }
    const single = this.singleChannel();
    if (single) {
      await this.translateWithSingleChannel(
        cue,
        single,
        untilEither(this.settleAbort.signal, signal)
      );
      return;
    }
    if (this.settings.meetingFinalChannel !== "llm") {
      // The configured channel is missing. Finishing this line on the chat
      // model is the silent fallback meeting mode promises not to make.
      return;
    }
    await this.translateActiveCue(cue, signal);
  }

  /**
   * D7: hand the settled bilingual line to the background worker, which owns
   * both the retention-limited transcript and the session's term memory. Only
   * meeting captions are recorded, and only while the user has the transcript
   * switched on — a line whose translation came back after the user paused or
   * hid the overlay is not written, however long it waited for it.
   *
   * A settled cue goes out once. A sentence the speaker really repeats is a
   * second cue and is recorded again; the same cue reaching here twice is the
   * same thing said once.
   */
  private recordMeetingLine(cue: SubtitleCue, translation: string): void {
    if (this.destroyed || cue.source !== "meet-dom" || !this.meetingMode()) {
      return;
    }
    if (!this.settings.enabled || this.overlayHidden()) {
      return;
    }
    if (this.recordedCueIds.has(cue.id)) {
      return;
    }
    this.recordedCueIds.add(cue.id);
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
    this.meetAdapter?.setNativeCaptionVisibility(nativeVisible || this.meetingChannelBroken);
  }

  /**
   * A meeting whose only channel cannot answer would otherwise leave the user
   * staring at an empty strip, because Meet's own captions are hidden for the
   * whole enabled session. Reading the source language beats reading nothing,
   * so they come back until the channel answers again.
   */
  private setMeetingChannelBroken(broken: boolean): void {
    if (this.meetingChannelBroken === broken) {
      return;
    }
    this.meetingChannelBroken = broken;
    this.syncNativeCaptionVisibility();
  }

  /**
   * The pair a request was sent under. An answer that comes back after the
   * user switched languages is written in the language they switched away
   * from: it is not shown, not recorded and not remembered, because keeping
   * it would caption the rest of the session in the wrong language.
   */
  private languagePair(): string {
    return `${this.settings.sourceLanguage}>${this.settings.targetLanguage}`;
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

  private rememberPaintedCue(cueId: string): void {
    this.paintedCueIds.delete(cueId);
    this.paintedCueIds.add(cueId);
    while (this.paintedCueIds.size > MAX_PAINTED_CUE_IDS) {
      const oldest = this.paintedCueIds.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.paintedCueIds.delete(oldest);
    }
  }

  private syncTranslationChannels(): void {
    // The user just changed the channel configuration; give it another chance
    // before deciding the meeting has no translator.
    this.setMeetingChannelBroken(false);
    this.draftTranslator?.destroy();
    this.draftTranslator = null;
    this.meetingChannel?.destroy();
    this.meetingChannel = null;
    this.filmFinalChannel?.destroy();
    this.filmFinalChannel = null;

    if (this.meetingMode() && this.settings.meetingFinalChannel !== "llm") {
      this.meetingChannel =
        this.settings.meetingFinalChannel === "local-mt"
          ? new LocalMtTranslator(this.sessionId)
          : createFastChannel(
              this.settings,
              this.sessionId,
              () => this.activeCue?.id ?? "",
              true,
              () => this.settings.glossary,
              true
            );
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
    if (this.usesDeepLOnly()) {
      // With nothing behind it, a DeepL answer slower than a draft's budget
      // would leave the line blank, and a name that reads the same in both
      // languages would count as a failure. As the caption itself it gets a
      // final channel's budget and the user's glossary.
      this.filmFinalChannel = createFastChannel(
        this.settings,
        this.sessionId,
        () => this.activeCue?.id ?? "",
        true
      );
    }
  }

  /**
   * Playback resumed. After a long pause the connection opened for the first
   * caption may be gone, and the next line would pay for a new one. The
   * worker skips a service it warmed within the last half minute.
   */
  private readonly handlePlay = (): void => {
    const source =
      this.activeSource ??
      [...this.availability].find(([, available]) => available)?.[0] ??
      null;
    if (!source || !this.settings.enabled || this.overlayHidden()) {
      return;
    }
    this.warmedUp = false;
    this.warmUpTranslationServices(source);
  };

  private async translateActiveCue(cue: SubtitleCue, signal?: AbortSignal): Promise<void> {
    try {
      const pair = this.languagePair();
      this.streamingPair = pair;
      const response = await this.requestTranslation(cue);
      if (this.destroyed || pair !== this.languagePair()) {
        return;
      }
      if (response.ok && response.translation) {
        this.rememberLocalTranslation(cue.text, response.translation.text);
      }
      if (signal?.aborted) {
        // Over the line's budget: the meeting moved on without it, and the
        // queue has already said so. Showing or recording it now would date
        // the transcript and the screen to a sentence nobody is still on.
        return;
      }
      if (!isCueWithinPlaybackWindow(cue, this.clock.nowMs())) {
        return;
      }
      if (response.ok && response.translation) {
        this.setMeetingChannelBroken(false);
      }
      if (!response.ok || !response.translation) {
        const message = response.error?.message ?? "翻译服务暂时不可用。";
        // The meeting's only translator just failed, so Meet's own captions
        // come back whether or not this line is still the one on screen.
        this.setMeetingChannelBroken(true);
        if (this.activeCue?.id !== cue.id) {
          if (this.meetingMode()) {
            this.report("error", message, cue.source);
          }
          return;
        }
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
          // The failure is what this line is waiting on now, not 「正在翻译…」.
          this.cancelPendingPlaceholder();
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

      const painted = this.applyCaption(cue, "final", response.translation.text);
      if (!painted && this.activeCue?.id !== cue.id) {
        this.reportUnshownLine(cue);
        return;
      }
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

/** Stops the request when the cue is superseded or the line runs out of budget. */
function untilEither(signal: AbortSignal, lineSignal?: AbortSignal): AbortSignal {
  return lineSignal ? AbortSignal.any([signal, lineSignal]) : signal;
}

/** Settles when the budget runs out, so the queue stops waiting on the line. */
function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function isYouTubePage(): boolean {
  return /(^|\.)youtube\.com$/.test(location.hostname) || /(^|\.)youtube-nocookie\.com$/.test(location.hostname);
}

function isNetflixPage(): boolean {
  return location.hostname === "netflix.com" || location.hostname === "www.netflix.com";
}
