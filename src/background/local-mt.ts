import type { SourceLanguage, TranslationSettings } from "../shared/types";

const LOCAL_MT_TIMEOUT_MS = 20_000;

/** LibreTranslate uses short codes; Simplified Chinese is `zh`. */
export function toLibreTranslateLang(language: SourceLanguage | "zh-CN"): string {
  if (language === "zh-CN") {
    return "zh";
  }
  return language;
}

/**
 * Calls a local LibreTranslate-compatible `/translate` endpoint.
 * Never throws: returns null on timeout, network, or invalid payload.
 */
export async function translateWithLibreTranslate(
  text: string,
  settings: TranslationSettings,
  signal?: AbortSignal
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
        source: toLibreTranslateLang(settings.sourceLanguage),
        target: toLibreTranslateLang(settings.targetLanguage),
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
    if (!translated || translated === source) {
      return null;
    }
    return translated;
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Translate many strings with limited concurrency to avoid flooding the local server. */
export async function translateBatchWithLibreTranslate(
  texts: string[],
  settings: TranslationSettings,
  concurrency = 4
): Promise<Array<string | null>> {
  const results: Array<string | null> = Array.from({ length: texts.length }, () => null);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < texts.length) {
      const index = next;
      next += 1;
      results[index] = await translateWithLibreTranslate(texts[index] ?? "", settings);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, texts.length)) }, () =>
    worker()
  );
  await Promise.all(workers);
  return results;
}
