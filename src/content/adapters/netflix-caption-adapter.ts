import { createSubtitleCue, normalizeSubtitleText } from "../../shared/subtitle";
import type { SubtitleCue } from "../../shared/types";
import type { SubtitleAdapter, SubtitleAdapterEvent } from "./types";

/**
 * Public, rendered caption containers observed on Netflix's web player.
 * This adapter deliberately reads only text already exposed in the page DOM;
 * it does not inspect media requests, encrypted streams, or player internals.
 */
export const NETFLIX_CAPTION_SELECTORS = [
  '[data-uia="player-subtitle-text"]',
  '[data-uia="player-timedtext"]',
  ".player-timedtext-text-container",
  ".player-timedtext",
  '[class*="timedtext"]'
] as const;

/** Document stylesheet id: hides every matching node the moment Netflix creates it. */
export const NETFLIX_NATIVE_HIDE_STYLE_ID = "tranlithion-hide-netflix-captions";

const CAPTION_POLL_INTERVAL_MS = 750;
// One frame is enough to collapse Netflix's burst of mutations for a single
// paint; longer settle sits directly on the latency path. Line growth is
// handled by cue-revise debounce in the controller, not by waiting here.
export const CAPTION_SETTLE_DELAY_MS = 16;
/**
 * A cue ends on media time, not on DOM emptiness.
 *
 * Netflix clears and repaints the caption container while the same line is
 * still on screen, so an empty read proves nothing by itself and any fixed
 * wall-clock delay is just a guess at how long a repaint takes. Playback
 * position is the signal that actually tracks what the viewer sees: it holds
 * still while paused, advances with the video at any speed, and jumps on seek.
 */
const CAPTION_HOLD_MEDIA_MS = 1_200;
/** How often to re-check playback position while the container reads empty. */
const CAPTION_TICK_INTERVAL_MS = 200;

/**
 * Whether an empty caption container means the line is really over.
 *
 * `lastTextMediaMs` is the playback position when the text was last visible.
 * Paused playback keeps the delta at zero and holds the caption; a negative
 * delta means the viewer seeked backwards, which ends it immediately.
 */
export function hasCaptionExpired(lastTextMediaMs: number, currentMediaMs: number): boolean {
  const elapsed = currentMediaMs - lastTextMediaMs;
  return elapsed < 0 || elapsed >= CAPTION_HOLD_MEDIA_MS;
}

export class NetflixCaptionAdapter implements SubtitleAdapter {
  readonly source = "netflix-dom" as const;

  private callback: ((event: SubtitleAdapterEvent) => void) | null = null;
  private observer: MutationObserver | null = null;
  private root: HTMLElement | null = null;
  private currentCue: SubtitleCue | null = null;
  private settleTimer: number | null = null;
  private pollTimer: number | null = null;
  private tickTimer: number | null = null;
  /** Playback position when the caption text was last actually visible. */
  private lastTextMediaMs = 0;
  private lastAvailability: boolean | null = null;
  private nativeCaptionsVisible = true;

  constructor(private readonly video: HTMLVideoElement) {}

  setNativeCaptionVisibility(visible: boolean): void {
    this.nativeCaptionsVisible = visible;
    this.applyNativeCaptionVisibility();
  }

  start(onEvent: (event: SubtitleAdapterEvent) => void): void {
    this.callback = onEvent;
    this.applyNativeCaptionVisibility();
    this.discoverRoot();
    this.pollTimer = window.setInterval(this.discoverRoot, CAPTION_POLL_INTERVAL_MS);
    // Mutations stop once the container is empty, so ending a cue needs its own
    // heartbeat rather than another DOM event that will never arrive.
    this.tickTimer = window.setInterval(this.tick, CAPTION_TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.observer?.disconnect();
    this.observer = null;
    this.nativeCaptionsVisible = true;
    removeNativeCaptionHideStyle();
    this.root = null;
    this.currentCue = null;
    this.callback = null;
  }

  private readonly discoverRoot = (): void => {
    const nextRoot = findNetflixCaptionRoot(this.video, this.root);
    if (nextRoot !== this.root) {
      const previousText = this.currentCue?.text ?? "";
      const nextText = nextRoot
        ? normalizeNetflixCaptionText(nextRoot.innerText || nextRoot.textContent || "")
        : "";
      // Netflix rebuilds timed-text nodes during SPA/layout updates. Ending the
      // cue just because the element identity changed produces an end→start flash
      // for the same line still on screen.
      const sameLineContinues = Boolean(this.currentCue && nextText && nextText === previousText);
      const reviseOnNewRoot = Boolean(this.currentCue && nextText && nextText !== previousText);
      if (!sameLineContinues && !reviseOnNewRoot) {
        this.finishCurrentCue();
      }
      this.observer?.disconnect();
      this.root = nextRoot;
      this.observer = null;
      if (this.root) {
        this.observer = new MutationObserver(this.scheduleRead);
        this.observer.observe(this.root, {
          childList: true,
          subtree: true,
          characterData: true
        });
      }
      if (sameLineContinues) {
        this.lastTextMediaMs = this.mediaTimeMs();
      } else if (reviseOnNewRoot) {
        this.reviseCurrentCue(nextText);
      } else {
        this.scheduleRead();
      }
    }
    this.setAvailability(Boolean(this.root));
  };

  private readonly scheduleRead = (): void => {
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
    }
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      this.readCaption();
    }, CAPTION_SETTLE_DELAY_MS);
  };

  private readVisibleCaption(): string {
    return this.root
      ? normalizeNetflixCaptionText(this.root.innerText || this.root.textContent || "")
      : "";
  }

  private mediaTimeMs(): number {
    return this.video.currentTime * 1_000;
  }

  /**
   * Ends the cue once playback has moved on without the caption coming back.
   * A negative delta means the viewer seeked backwards, which also ends it.
   */
  private readonly tick = (): void => {
    if (!this.currentCue) {
      return;
    }
    if (this.readVisibleCaption()) {
      this.lastTextMediaMs = this.mediaTimeMs();
      return;
    }
    if (hasCaptionExpired(this.lastTextMediaMs, this.mediaTimeMs())) {
      this.finishCurrentCue();
    }
  };

  private readCaption(): void {
    const text = this.readVisibleCaption();
    if (!text) {
      // An empty container is not evidence the line is over; `tick` decides
      // that from playback position instead.
      return;
    }
    this.lastTextMediaMs = this.mediaTimeMs();
    if (text === this.currentCue?.text) {
      return;
    }

    // Netflix often grows or rewrites the same on-screen slot (half line → full
    // line). Ending here would abort translation and flash the overlay.
    if (this.currentCue) {
      this.reviseCurrentCue(text);
      return;
    }

    const cue = createSubtitleCue({
      source: this.source,
      startMs: this.video.currentTime * 1_000,
      endMs: null,
      text,
      isFinal: true
    });
    if (!cue) {
      return;
    }
    this.currentCue = cue;
    this.emit({ type: "cue-start", source: this.source, cue });
  }

  /**
   * Same caption slot, new text. Keeps the open cue alive so the controller can
   * retranslate without a teardown race against sticky Chinese.
   */
  private reviseCurrentCue(text: string): void {
    if (!this.currentCue) {
      return;
    }
    const previousCueId = this.currentCue.id;
    const cue = createSubtitleCue({
      source: this.source,
      // Preserve the slot's original start so reading-time math stays stable.
      startMs: this.currentCue.startMs,
      endMs: null,
      text,
      isFinal: true
    });
    if (!cue) {
      return;
    }
    this.lastTextMediaMs = this.mediaTimeMs();
    this.currentCue = cue;
    this.emit({
      type: "cue-revise",
      source: this.source,
      cue,
      previousCueId
    });
  }

  private finishCurrentCue(): void {
    if (!this.currentCue) {
      return;
    }
    this.emit({
      type: "cue-end",
      source: this.source,
      cueId: this.currentCue.id,
      atMs: Math.round(this.video.currentTime * 1_000)
    });
    this.currentCue = null;
  }

  /**
   * Hide every Netflix caption node via a document stylesheet. Per-element
   * opacity lags behind Netflix creating new timed-text nodes (up to the poll
   * interval), which is exactly the native-subtitle flicker viewers reported.
   */
  private applyNativeCaptionVisibility(): void {
    if (this.nativeCaptionsVisible) {
      removeNativeCaptionHideStyle();
      return;
    }
    ensureNativeCaptionHideStyle();
  }

  private setAvailability(available: boolean): void {
    if (this.lastAvailability === available) {
      return;
    }
    this.lastAvailability = available;
    this.emit({ type: "availability", source: this.source, available });
  }

  private emit(event: SubtitleAdapterEvent): void {
    this.callback?.(event);
  }
}

export function normalizeNetflixCaptionText(value: string): string {
  return normalizeSubtitleText(value);
}

export function nativeCaptionHideCss(): string {
  return `${NETFLIX_CAPTION_SELECTORS.join(", ")} { opacity: 0 !important; }`;
}

function ensureNativeCaptionHideStyle(): void {
  if (document.getElementById(NETFLIX_NATIVE_HIDE_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = NETFLIX_NATIVE_HIDE_STYLE_ID;
  style.textContent = nativeCaptionHideCss();
  (document.head ?? document.documentElement).append(style);
}

function removeNativeCaptionHideStyle(): void {
  document.getElementById(NETFLIX_NATIVE_HIDE_STYLE_ID)?.remove();
}

function findNetflixCaptionRoot(
  video: HTMLVideoElement,
  preferredRoot: HTMLElement | null = null
): HTMLElement | null {
  for (const selector of NETFLIX_CAPTION_SELECTORS) {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(isVisible);
    // Keep the observed node only while it still carries text. An empty preferred
    // root must not block switching onto a sibling Netflix just filled.
    if (preferredRoot && candidates.includes(preferredRoot)) {
      const preferredText = normalizeNetflixCaptionText(
        preferredRoot.innerText || preferredRoot.textContent || ""
      );
      if (preferredText) {
        return preferredRoot;
      }
    }
    candidates.sort((left, right) => captionPriority(right, video) - captionPriority(left, video));
    if (candidates[0]) {
      return candidates[0];
    }
  }
  return null;
}

function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function captionPriority(element: HTMLElement, video: HTMLVideoElement): number {
  const caption = element.getBoundingClientRect();
  const player = video.getBoundingClientRect();
  const overlapsPlayer =
    caption.right >= player.left &&
    caption.left <= player.right &&
    caption.bottom >= player.top &&
    caption.top <= player.bottom;
  const hasText = Boolean(normalizeNetflixCaptionText(element.innerText || element.textContent || ""));
  return (overlapsPlayer ? 1_000_000 : 0) + (hasText ? 10_000 : 0) + caption.width * caption.height;
}
