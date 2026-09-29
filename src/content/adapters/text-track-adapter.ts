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
   * The user picked a different source language, so the track is chosen
   * again for it rather than left as whatever matched the language they
   * left. When a track matches the new language the reader moves to it and
   * the line it was reading ends; when none matches, the page's one readable
   * track is still read, exactly as it would be on a fresh load — the
   * setting alone never makes readable subtitles unavailable.
   *
   * Landing on the same track is therefore the ordinary case, and it must
   * not disturb the line on screen: the viewer is still reading it.
   */
  setSourceLanguage(sourceLanguage: SourceLanguage): void {
    if (sourceLanguage === this.sourceLanguage) {
      return;
    }
    this.sourceLanguage = sourceLanguage;
    if (!this.callback) {
      return;
    }
    if ((chooseSubtitleTrack(this.video.textTracks, sourceLanguage) ?? null) === this.track) {
      return;
    }
    this.endActiveCue();
    this.detachTrack();
    this.emit({ type: "availability", source: this.source, available: false });
    this.refresh();
  }

  /**
   * The lines the track will show after `afterMs`, soonest first, at most
   * `limit` of them.
   *
   * Each is built exactly as it will be read once it is on screen alone, so a
   * translation made for it now answers the request made for it then. A line
   * that ends up on screen together with another is read as one merged cue,
   * which is simply translated when it comes.
   */
  upcomingCues(afterMs: number, limit: number): SubtitleCue[] {
    const cues = this.track?.cues;
    if (!cues || limit <= 0) {
      return [];
    }
    const later: ReadableTextTrackCue[] = [];
    for (let index = 0; index < cues.length; index += 1) {
      const cue = cues[index] as ReadableTextTrackCue;
      // Rounded as a cue's own start is, so the line on screen is not also
      // counted as one still to come.
      if (Math.round(cue.startTime * 1_000) > afterMs) {
        later.push(cue);
      }
    }
    later.sort((left, right) => left.startTime - right.startTime);
    const upcoming: SubtitleCue[] = [];
    for (const cue of later) {
      if (upcoming.length >= limit) {
        break;
      }
      const next = createSubtitleCue({
        source: this.source,
        startMs: cue.startTime * 1_000,
        endMs: cue.endTime * 1_000,
        text: readCueText(cue),
        isFinal: true
      });
      if (next) {
        upcoming.push(next);
      }
    }
    return upcoming;
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
