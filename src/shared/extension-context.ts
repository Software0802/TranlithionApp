/**
 * Manifest V3 content scripts keep running after the extension is reloaded
 * until the tab is refreshed. Any chrome.runtime.* call then throws
 * "Extension context invalidated" and clutters chrome://extensions errors.
 */

export function isExtensionContextValid(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

/** Chrome may reject with a cross-realm Error; avoid `instanceof`. */
export function errorMessageOf(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error ?? "");
}

export function isExtensionContextInvalidatedError(error: unknown): boolean {
  const message = errorMessageOf(error);
  return (
    message.includes("Extension context invalidated") || message.includes("context invalidated")
  );
}

/**
 * sendMessage that never rejects. Callers treat `undefined` as
 * "background unreachable; stop or degrade quietly."
 *
 * Content scripts must not rethrow: a cross-realm invalidated Error can fail
 * `instanceof` checks and otherwise become an uncaught rejection on `void`.
 */
export async function safeRuntimeSendMessage<T = unknown>(
  message: unknown
): Promise<T | undefined> {
  if (!isExtensionContextValid()) {
    return undefined;
  }
  try {
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      return undefined;
    }
    // Any other sendMessage failure is also non-fatal for content UX.
    return undefined;
  }
}
