import type { SubtitleCue, SubtitleSource } from "../../shared/types";

/**
 * Wording a live recognizer has published and then taken back. The cue
 * carrying this is the correction that replaces it, so a transcript that
 * already stored the withdrawn line can drop it again.
 */
interface CueRetraction {
  retracts?: string[];
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
