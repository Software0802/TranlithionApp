import { trackLanguageMatchers } from "./language";
import type { SourceLanguage, SubtitleCue, SubtitleSource } from "./types";

const ENTITY_REPLACEMENTS: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": "\"",
  "&#39;": "'"
};

export function normalizeSubtitleText(value: string): string {
  const withoutTags = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  const decoded = withoutTags.replace(
    /&(nbsp|amp|lt|gt|quot|#39);/gi,
    (entity) => ENTITY_REPLACEMENTS[entity.toLowerCase()] ?? entity
  );
  return decoded
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function hashSubtitleText(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function createCueId(
  source: SubtitleSource,
  startMs: number,
  endMs: number | null,
  text: string,
  speaker?: string
): string {
  const base = `${source}:${Math.round(startMs)}:${endMs === null ? "open" : Math.round(endMs)}:${hashSubtitleText(text)}`;
  // Two people can say the same words in the same second; without the speaker
  // in the id the second line would look like a repeat of the first.
  return speaker ? `${base}:${hashSubtitleText(speaker)}` : base;
}

export function createSubtitleCue(input: {
  source: SubtitleSource;
  startMs: number;
  endMs: number | null;
  text: string;
  isFinal?: boolean;
  speaker?: string;
}): SubtitleCue | null {
  const text = normalizeSubtitleText(input.text);
  if (!text) {
    return null;
  }
  const speaker = input.speaker ? normalizeSubtitleText(input.speaker) : "";
  return {
    id: createCueId(input.source, input.startMs, input.endMs, text, speaker || undefined),
    startMs: Math.max(0, Math.round(input.startMs)),
    endMs: input.endMs === null ? null : Math.max(0, Math.round(input.endMs)),
    text,
    isFinal: input.isFinal ?? true,
    source: input.source,
    ...(speaker ? { speaker } : {})
  };
}

export function chooseSubtitleTrack(
  tracks: TextTrackList,
  sourceLanguage: SourceLanguage
): TextTrack | undefined {
  const candidates: TextTrack[] = [];
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    if (track.kind === "captions" || track.kind === "subtitles") {
      candidates.push(track);
    }
  }

  const languageMatchers = trackLanguageMatchers(sourceLanguage);
  return candidates.find((track) => {
    const hint = `${track.language} ${track.label}`.toLocaleLowerCase();
    return languageMatchers.some((matcher) => hint.includes(matcher));
  }) ?? candidates[0];
}

export function isCueWithinPlaybackWindow(cue: SubtitleCue, currentMs: number): boolean {
  if (currentMs < cue.startMs) {
    return false;
  }
  return cue.endMs === null || currentMs <= cue.endMs + 120;
}
