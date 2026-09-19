import { toDeepLSource, toDeepLTarget } from "../shared/language";
import type { TranslationSettings } from "../shared/types";

/**
 * Remote draft channel: a dedicated machine-translation endpoint that answers
 * far faster than a chat model, used to put readable text on screen while the
 * quality translation is still streaming.
 *
 * This lives in the background worker because it needs an API key, and keys
 * must never reach a content script sharing a page with the video site.
 *
 * Nothing here throws. A draft that fails, times out, or is superseded simply
 * resolves to null and the caption waits for the main translator as before.
 */

/**
 * Drafts are only worth showing while the main request is still in flight. A
 * slower answer would replace the caption around the time the real translation
 * lands, so it is dropped instead.
 */
const REMOTE_DRAFT_TIMEOUT_MS = 1_200;
/**
 * When this channel *is* the caption (meeting mode), there is nothing slower
 * waiting behind it, so it is worth waiting a little longer rather than
 * showing the user nothing.
 */
const FINAL_CHANNEL_TIMEOUT_MS = 4_000;

export interface RemoteDraftInput {
  text: string;
  settings: TranslationSettings;
  signal?: AbortSignal;
  /** The caller is using this channel as the final caption, not as a preview. */
  asFinal?: boolean;
}

export async function translateDraft(input: RemoteDraftInput): Promise<string | null> {
  const { settings } = input;
  const text = input.text.trim();
  if (!text || settings.draftProvider === "browser") {
    return null;
  }
  if (!settings.draftCaptions && !input.asFinal) {
    return null;
  }
  if (settings.draftProvider === "deepl" && !settings.draftApiKey) {
    return null;
  }

  const controller = new AbortController();
  const abortForNewerCue = () => controller.abort();
  if (input.signal?.aborted) {
    return null;
  }
  input.signal?.addEventListener("abort", abortForNewerCue, { once: true });
  const timer = globalThis.setTimeout(
    () => controller.abort(),
    input.asFinal ? FINAL_CHANNEL_TIMEOUT_MS : REMOTE_DRAFT_TIMEOUT_MS
  );

  try {
    const response = await fetch(settings.draftEndpointUrl, {
      method: "POST",
      headers: draftRequestHeaders(settings),
      body: JSON.stringify(draftRequestBody(settings, text)),
      signal: controller.signal
    });
    if (!response.ok) {
      return null;
    }
    const payload: unknown = await response.json();
    const translated = readDraftTranslation(settings, payload);
    if (!translated || controller.signal.aborted) {
      return null;
    }
    // An echo of the source reads as a finished translation that silently
    // failed, which is worse than leaving the caption to the main translator.
    return translated === text ? null : translated;
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timer);
    input.signal?.removeEventListener("abort", abortForNewerCue);
  }
}

function draftRequestHeaders(settings: TranslationSettings): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.draftProvider === "deepl") {
    headers.Authorization = `DeepL-Auth-Key ${settings.draftApiKey}`;
    return headers;
  }
  if (settings.draftApiKey) {
    headers.Authorization = `Bearer ${settings.draftApiKey}`;
  }
  return headers;
}

function draftRequestBody(settings: TranslationSettings, text: string): unknown {
  if (settings.draftProvider === "deepl") {
    return {
      text: [text],
      source_lang: toDeepLSource(settings.sourceLanguage),
      target_lang: toDeepLTarget(settings.targetLanguage)
    };
  }
  return {
    text,
    source: settings.sourceLanguage,
    target: settings.targetLanguage
  };
}

function readDraftTranslation(settings: TranslationSettings, payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  if (settings.draftProvider === "deepl") {
    const translations = (payload as { translations?: unknown }).translations;
    if (!Array.isArray(translations) || translations.length === 0) {
      return null;
    }
    const first = translations[0] as { text?: unknown };
    return typeof first?.text === "string" ? first.text.trim() || null : null;
  }
  const translation = (payload as { translation?: unknown }).translation;
  return typeof translation === "string" ? translation.trim() || null : null;
}
