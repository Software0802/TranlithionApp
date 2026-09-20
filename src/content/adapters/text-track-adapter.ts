import { chooseSubtitleTrack, createSubtitleCue } from "../../shared/subtitle";
import type { SourceLanguage, SubtitleCue } from "../../shared/types";
import type { SubtitleAdapter, SubtitleAdapterEvent } from "./types";

interface ReadableTextTrackCue extends TextTrackCue {
  text?: string;
  getCueAsHTML?: () => DocumentFragment;
}

export class TextTrackAdapter implements SubtitleAdapter {
  readonly source = "text-track" as const;

  private callback: ((event: SubtitleAdapterEvent) => void) | null = null;
  private track: TextTrack | null = null;
  private activeCue: SubtitleCue | null = null;
  private refreshTimer: number | null = null;

  constructor(
    private readonly video: HTMLVideoElement,
    private sourceLanguage: SourceLanguage
  ) {}

  /**
   * The user picked a different source language. The track chosen for the
   * previous one is the wrong track now, so it is dropped here rather than
   * kept until something else happens to rebuild the page's controller — and
   * if this video carries no track in the new language, the adapter says so
   * instead of translating the old one as if it were it.
   */
  setSourceLanguage(sourceLanguage: SourceLanguage): void {
    if (sourceLanguage === this.sourceLanguage) {
      return;
    }
    this.sourceLanguage = sourceLanguage;
    if (!this.callback) {
      return;
    }
    this.endActiveCue();
    this.detachTrack();
    this.emit({ type: "availability", source: this.source, available: false });
    this.refresh();
  }

  start(onEvent: (event: SubtitleAdapterEvent) => void): void {
    this.callback = onEvent;
    this.refresh();
    this.video.addEventListener("loadedmetadata", this.refresh);
    this.video.textTracks.addEventListener("addtrack", this.refresh);
    this.refreshTimer = window.setInterval(this.refresh, 1_250);
  }

  stop(): void {
    this.video.removeEventListener("loadedmetadata", this.refresh);
    this.video.textTracks.removeEventListener("addtrack", this.refresh);
    if (this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.detachTrack();
    this.callback = null;
  }

  private readonly refresh = (): void => {
    const nextTrack = chooseSubtitleTrack(this.video.textTracks, this.sourceLanguage) ?? null;
    if (nextTrack === this.track) {
      this.handleCueChange();
      return;
    }

    this.detachTrack();
    this.track = nextTrack;
    if (!this.track) {
      this.emit({ type: "availability", source: this.source, available: false });
      return;
    }

    try {
      this.track.mode = "hidden";
    } catch {
      // A site can lock a track's mode. cuechange may still be observable.
    }
    this.track.addEventListener("cuechange", this.handleCueChange);
    this.emit({ type: "availability", source: this.source, available: true });
    this.handleCueChange();
  };

  private readonly handleCueChange = (): void => {
    const nextCue = this.readActiveCue();
    if (nextCue?.id === this.activeCue?.id) {
      return;
    }
    this.endActiveCue();
    this.activeCue = nextCue;
    if (nextCue) {
      this.emit({ type: "cue-start", source: this.source, cue: nextCue });
    }
  };

  private endActiveCue(): void {
    if (!this.activeCue) {
      return;
    }
    this.emit({
      type: "cue-end",
      source: this.source,
      cueId: this.activeCue.id,
      atMs: Math.round(this.video.currentTime * 1_000)
    });
    this.activeCue = null;
  }

  private readActiveCue(): SubtitleCue | null {
    if (!this.track?.activeCues?.length) {
      return null;
    }

    const activeCues: ReadableTextTrackCue[] = [];
    for (let index = 0; index < this.track.activeCues.length; index += 1) {
      activeCues.push(this.track.activeCues[index] as ReadableTextTrackCue);
    }
    const text = activeCues.map(readCueText).filter(Boolean).join("\n");
    const startMs = Math.min(...activeCues.map((cue) => cue.startTime * 1_000));
    const endMs = Math.max(...activeCues.map((cue) => cue.endTime * 1_000));
    return createSubtitleCue({
      source: this.source,
      startMs,
      endMs,
      text,
      isFinal: true
    });
  }

  private detachTrack(): void {
    if (this.track) {
      this.track.removeEventListener("cuechange", this.handleCueChange);
    }
    this.track = null;
    this.activeCue = null;
  }

  private emit(event: SubtitleAdapterEvent): void {
    this.callback?.(event);
  }
}

function readCueText(cue: ReadableTextTrackCue): string {
  if (typeof cue.text === "string") {
    return cue.text;
  }
  const rendered = cue.getCueAsHTML?.();
  return rendered?.textContent ?? "";
}
