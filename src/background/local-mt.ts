import { toShortLanguageCode, type LanguageTag } from "../shared/language";
import type { TranslationSettings } from "../shared/types";

const LOCAL_MT_TIMEOUT_MS = 20_000;

/** LibreTranslate uses short codes; Simplified Chinese is `zh`. */
export function toLibreTranslateLang(language: LanguageTag): string {
  return toShortLanguageCode(language);
}

/**
 * Calls a local LibreTranslate-compatible `/translate` endpoint.
 * Never throws: returns null on timeout, network, or invalid payload.
 *
 * `pair` overrides the configured languages: a web page is translated from
 * whichever language each string is written in.
 */
export async function translateWithLibreTranslate(
  text: string,
  settings: TranslationSettings,
  signal?: AbortSignal,
  pair: { source: LanguageTag; target: LanguageTag } = {
    source: settings.sourceLanguage,
    target: settings.targetLanguage
  }
): Promise<string | null> {
  const source = text.trim();
  if (!source || !settings.localMtEnabled) {
    return null;
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) {
    return null;
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = globalThis.setTimeout(() => controller.abort(), LOCAL_MT_TIMEOUT_MS);

  try {
    const response = await fetch(settings.localMtUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: source,
        source: toLibreTranslateLang(pair.source),
        target: toLibreTranslateLang(pair.target),
        format: "text"
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      return null;
    }
    const payload: unknown = await response.json();
    const translated =
      typeof payload === "object" &&
      payload !== null &&
      typeof (payload as { translatedText?: unknown }).translatedText === "string"
        ? (payload as { translatedText: string }).translatedText.trim()
        : "";
    // Text that survives translation unchanged — a name, an acronym, a figure
    // — is a result, not a failure. Callers that have nothing to gain from an
    // identical string decide that for themselves.
    return translated || null;
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
