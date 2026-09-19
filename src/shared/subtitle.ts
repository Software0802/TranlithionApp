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
  text: string
): string {
  return `${source}:${Math.round(startMs)}:${endMs === null ? "open" : Math.round(endMs)}:${hashSubtitleText(text)}`;
}

export function createSubtitleCue(input: {
  source: SubtitleSource;
  startMs: number;
  endMs: number | null;
  text: string;
  isFinal?: boolean;
}): SubtitleCue | null {
  const text = normalizeSubtitleText(input.text);
  if (!text) {
    return null;
  }
  return {
    id: createCueId(input.source, input.startMs, input.endMs, text),
    startMs: Math.max(0, Math.round(input.startMs)),
    endMs: input.endMs === null ? null : Math.max(0, Math.round(input.endMs)),
    text,
    isFinal: input.isFinal ?? true,
    source: input.source
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

  const languageMatchers =
    sourceLanguage === "ja"
      ? ["ja", "jpn", "japanese", "日本"]
      : ["en", "eng", "english"];
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
