import type { SubtitleCue, SubtitleSource } from "../../shared/types";

export type SubtitleAdapterEvent =
  | { type: "availability"; source: SubtitleSource; available: boolean }
  | { type: "cue-start"; source: SubtitleSource; cue: SubtitleCue }
  /** Same on-screen slot, new text (Netflix often grows/rewrites one line in place). */
  | {
      type: "cue-revise";
      source: SubtitleSource;
      cue: SubtitleCue;
      previousCueId: string;
    }
  | { type: "cue-end"; source: SubtitleSource; cueId: string; atMs: number };

export interface SubtitleAdapter {
  readonly source: SubtitleSource;
  start(onEvent: (event: SubtitleAdapterEvent) => void): void;
  stop(): void;
}
