import type { GlossaryEntry } from "./types";

/**
 * Forces the user's fixed renderings onto a machine translation.
 *
 * The chat model is handed the glossary in its system prefix and follows it.
 * DeepL, a custom HTTP endpoint and LibreTranslate take no terminology at
 * all, so a name or a project term the user pasted into settings comes back
 * either untouched or invented — and in a meeting those are exactly the words
 * that repeat. Whatever the service left of the source term is replaced with
 * the rendering the user asked for.
 */
export function applyTerminology(text: string, terminology: GlossaryEntry[]): string {
  let result = text;
  for (const entry of terminology) {
    const source = entry.source.trim();
    const target = entry.target.trim();
    if (!source || !target || source === target) {
      continue;
    }
    result = result.replace(termPattern(source), target);
  }
  return result;
}

/**
 * Matches the term as a word rather than as a run of characters, so "AI" does
 * not rewrite "said". Scripts that are written without spaces have no word
 * boundary to anchor to, and none is invented for them.
 *
 * The spelling has to be the one the user wrote: an entry like `IT = 信息技术`
 * is exactly the kind a meeting glossary is for, and matching it loosely would
 * turn every "it" in an English caption into a term nobody said.
 */
function termPattern(source: string): RegExp {
  const prefix = /^[\w]/.test(source) ? "(?<![\\w])" : "";
  const suffix = /[\w]$/.test(source) ? "(?![\\w])" : "";
  return new RegExp(`${prefix}${escapeRegExp(source)}${suffix}`, "g");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
