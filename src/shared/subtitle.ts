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
  return (
    candidates.find((track) => matchesLanguage(track, languageMatchers)) ?? candidates[0]
  );
}

/**
 * Whether this track is in the language asked for.
 *
 * A matcher has to be a whole subtag of the track's language or a whole word
 * of its label: "en" is inside "auto-generated" and inside "french", and a
 * page that lists a Japanese track before an English one would otherwise
 * hand the Japanese one to a translator asked for English. Matchers written
 * in a script that has no word breaks are looked for in the label as they
 * are, because there is no boundary to anchor them to.
 */
function matchesLanguage(track: TextTrack, matchers: readonly string[]): boolean {
  const subtags = track.language.toLocaleLowerCase().split(/[-_]/).filter(Boolean);
  const label = track.label.toLocaleLowerCase();
  const labelWords = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return matchers.some((matcher) => {
    if (subtags.includes(matcher) || labelWords.includes(matcher)) {
      return true;
    }
    return !/^[\x20-\x7e]+$/.test(matcher) && label.includes(matcher);
  });
}

export function isCueWithinPlaybackWindow(cue: SubtitleCue, currentMs: number): boolean {
  if (currentMs < cue.startMs) {
    return false;
  }
  return cue.endMs === null || currentMs <= cue.endMs + 120;
}
