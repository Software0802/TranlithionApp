import type { SubtitleCue, SubtitleSource } from "../../shared/types";

/**
 * Cues a live recognizer published and then took back. The cue carrying this
 * is the correction that replaces them, so a transcript that already stored
 * one of them can drop exactly that line — identity, not wording: two people
 * saying "Okay." in one meeting is two things said.
 */
interface CueRetraction {
  retractedCueIds?: string[];
}

export type SubtitleAdapterEvent =
  | { type: "availability"; source: SubtitleSource; available: boolean }
  | ({ type: "cue-start"; source: SubtitleSource; cue: SubtitleCue } & CueRetraction)
  /** Same on-screen slot, new text (Netflix often grows/rewrites one line in place). */
  | ({
      type: "cue-revise";
      source: SubtitleSource;
      cue: SubtitleCue;
      previousCueId: string;
    } & CueRetraction)
  | { type: "cue-end"; source: SubtitleSource; cueId: string; atMs: number };

export interface SubtitleAdapter {
  readonly source: SubtitleSource;
  start(onEvent: (event: SubtitleAdapterEvent) => void): void;
  stop(): void;
}
