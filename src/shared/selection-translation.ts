import type { LanguageTag } from "./language";
import type { ExtensionMessage, TextsTranslationResponse } from "./messages";
import { PAGE_MAX_REQUEST_ITEMS, pageEngineLabel, resolvePageEngine } from "./page-translation";
import { OnDeviceTranslatorError, type OnDeviceTranslatorPool } from "./translator-api";
import type { PublicTranslationSettings } from "./types";

/**
 * Translating a piece of text the user picked — a selection shown next to the
 * page, or an entry in the side panel — through the page channel. Paragraphs
 * are translated as paragraphs and come back on their own lines.
 */

export type TextTranslationResult =
  | { ok: true; text: string; engineLabel: string }
  | { ok: false; error: string; needsActivation?: boolean };

export interface TextTranslationDeps {
  /** Chrome's on-device translators into the target language. */
  pool: () => OnDeviceTranslatorPool;
  /** The background worker, for every other engine. */
  send: (message: ExtensionMessage) => Promise<TextsTranslationResponse | undefined>;
}

/** Keeps paragraph breaks, drops layout whitespace. */
export function normalizeSelectedText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitParagraphs(text: string): string[] {
  const paragraphs = text
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  if (paragraphs.length <= PAGE_MAX_REQUEST_ITEMS) {
    return paragraphs;
  }
  // More paragraphs than one request carries: pair them up until they fit.
  const size = Math.ceil(paragraphs.length / PAGE_MAX_REQUEST_ITEMS);
  const merged: string[] = [];
  for (let index = 0; index < paragraphs.length; index += size) {
    merged.push(paragraphs.slice(index, index + size).join(" "));
  }
  return merged;
}

export async function translateSelectedText(
  text: string,
  source: LanguageTag,
  settings: PublicTranslationSettings,
  deps: TextTranslationDeps
): Promise<TextTranslationResult> {
  const engine = resolvePageEngine(settings);
  const engineLabel = pageEngineLabel(engine);
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length === 0) {
    return { ok: false, error: "没有可以翻译的文字。" };
  }
  if (!settings.enabled) {
    return { ok: false, error: "翻译已暂停。请在扩展弹窗中重新开启。" };
  }
  if (engine === "browser") {
    const pool = deps.pool();
    try {
      const translated: string[] = [];
      for (const paragraph of paragraphs) {
        translated.push((await pool.translate(paragraph, source)).trim());
      }
      return { ok: true, text: translated.join("\n"), engineLabel };
    } catch (error) {
      if (error instanceof OnDeviceTranslatorError && error.reason === "needs-activation") {
        return { ok: false, error: error.message, needsActivation: true };
      }
      const reason = error instanceof Error ? error.message : "Chrome 本地翻译不可用。";
      return { ok: false, error: `${reason}可以在扩展设置里换一个网页翻译通道。` };
    }
  }
  const response = await deps.send({
    type: "TRANSLATE_TEXTS",
    texts: paragraphs,
    source,
    markup: false
  });
  if (!response) {
    return { ok: false, error: "扩展后台没有响应。请刷新页面，或在 chrome://extensions 重新加载扩展。" };
  }
  if (!response.ok || !response.texts) {
    return { ok: false, error: response.error ?? "翻译服务没有返回译文。" };
  }
  const answered = response.texts;
  if (answered.every((item) => !item?.trim())) {
    return { ok: false, error: "翻译服务没有返回译文。" };
  }
  // A paragraph the service could not translate is shown as it was, not dropped.
  return {
    ok: true,
    text: paragraphs.map((paragraph, index) => answered[index]?.trim() || paragraph).join("\n"),
    engineLabel
  };
}
