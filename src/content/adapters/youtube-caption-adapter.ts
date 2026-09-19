import { createSubtitleCue, normalizeSubtitleText } from "../../shared/subtitle";
import type { SubtitleCue } from "../../shared/types";
import type { SubtitleAdapter, SubtitleAdapterEvent } from "./types";

const CAPTION_ROOT_SELECTOR = ".ytp-caption-window-container";
const CAPTION_SEGMENT_SELECTOR = ".ytp-caption-segment";

export class YouTubeCaptionAdapter implements SubtitleAdapter {
  readonly source = "youtube-dom" as const;

  private callback: ((event: SubtitleAdapterEvent) => void) | null = null;
  private observer: MutationObserver | null = null;
  private root: Element | null = null;
  private currentCue: SubtitleCue | null = null;
  private settleTimer: number | null = null;
  private pollTimer: number | null = null;
  private lastAvailability: boolean | null = null;
  private nativeCaptionsVisible = true;
  private originalNativeOpacity: { value: string; priority: string } | null = null;

  constructor(private readonly video: HTMLVideoElement) {}

  setNativeCaptionVisibility(visible: boolean): void {
    this.nativeCaptionsVisible = visible;
    this.applyNativeCaptionVisibility();
  }

  start(onEvent: (event: SubtitleAdapterEvent) => void): void {
    this.callback = onEvent;
    this.discoverRoot();
    this.pollTimer = window.setInterval(() => this.discoverRoot(), 1_000);
  }

  stop(): void {
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.observer?.disconnect();
    this.observer = null;
    this.restoreNativeCaptionVisibility();
    this.root = null;
    this.originalNativeOpacity = null;
    this.currentCue = null;
    this.callback = null;
  }

  private discoverRoot(): void {
    const nextRoot = document.querySelector(CAPTION_ROOT_SELECTOR);
    if (nextRoot !== this.root) {
      this.observer?.disconnect();
      this.restoreNativeCaptionVisibility();
      this.root = nextRoot;
      this.observer = null;
      this.originalNativeOpacity = this.root instanceof HTMLElement
        ? {
            value: this.root.style.getPropertyValue("opacity"),
            priority: this.root.style.getPropertyPriority("opacity")
          }
        : null;
      if (this.root) {
        this.observer = new MutationObserver(this.scheduleRead);
        this.observer.observe(this.root, {
          childList: true,
          subtree: true,
          characterData: true
        });
      }
      this.applyNativeCaptionVisibility();
    }
    this.setAvailability(Boolean(this.root));
    this.readCaption();
  }

  private readonly scheduleRead = (): void => {
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
    }
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      this.readCaption();
    }, 80);
  };

  private readCaption(): void {
    const text = this.root ? captionText(this.root) : "";
    if (!text) {
      this.finishCurrentCue();
      return;
    }
    if (text === this.currentCue?.text) {
      return;
    }

    this.finishCurrentCue();
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

  private applyNativeCaptionVisibility(): void {
    if (!(this.root instanceof HTMLElement)) {
      return;
    }
    if (this.nativeCaptionsVisible) {
      this.restoreNativeCaptionVisibility();
      return;
    }
    this.root.style.setProperty("opacity", "0", "important");
  }

  private restoreNativeCaptionVisibility(): void {
    if (!(this.root instanceof HTMLElement) || !this.originalNativeOpacity) {
      return;
    }
    const { value, priority } = this.originalNativeOpacity;
    if (value) {
      this.root.style.setProperty("opacity", value, priority);
    } else {
      this.root.style.removeProperty("opacity");
    }
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

function captionText(root: Element): string {
  const segments = Array.from(root.querySelectorAll(CAPTION_SEGMENT_SELECTOR));
  if (!segments.length) {
    return normalizeSubtitleText(root.textContent ?? "");
  }

  return normalizeSubtitleText(
    segments.reduce((joined, segment) => {
      const next = segment.textContent ?? "";
      if (!joined || !next) {
        return joined + next;
      }
      return /[A-Za-z0-9]$/.test(joined) && /^[A-Za-z0-9]/.test(next)
        ? `${joined} ${next}`
        : joined + next;
    }, "")
  );
}
