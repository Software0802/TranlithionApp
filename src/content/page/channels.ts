import { safeRuntimeSendMessage } from "../../shared/extension-context";
import type { LanguageTag } from "../../shared/language";
import type { ExtensionMessage, TextsTranslationResponse } from "../../shared/messages";
import {
  pageBatchLimits,
  pageEngineSupportsMarkup,
  resolvePageEngine,
  type PageBatchLimits,
  type PageEngine
} from "../../shared/page-translation";
import { OnDeviceTranslatorError, OnDeviceTranslatorPool } from "../../shared/translator-api";
import type { PublicTranslationSettings } from "../../shared/types";

/**
 * How a page's strings reach a translator. Chrome's on-device model runs
 * right here in the content script; every other engine runs in the background
 * worker, because it needs a key or a host permission the page must never
 * hold. Either way the page translator sees the same interface.
 */

export type PageChannelErrorKind =
  /** Nothing more will translate until the user changes something. */
  | "fatal"
  /** Chrome is waiting for one click on the page before it sets the model up. */
  | "needs-activation"
  /** This request failed; the next one may not. */
  | "transient";

export class PageChannelError extends Error {
  constructor(
    message: string,
    readonly kind: PageChannelErrorKind
  ) {
    super(message);
    this.name = "PageChannelError";
  }
}

export interface PageChannel {
  readonly engine: PageEngine;
  /** Whether the channel keeps `<t0>` placeholder tags in place. */
  readonly markup: boolean;
  readonly limits: PageBatchLimits;
  /** One translation per string, in order; null for a string that failed. */
  translate(texts: string[], source: LanguageTag, markup: boolean): Promise<Array<string | null>>;
  /** Asks Chrome again for what it refused. Call from inside a click. */
  activate?(): Promise<boolean>;
  destroy(): void;
}

export function createPageChannel(
  settings: PublicTranslationSettings,
  onDownloadProgress?: (fraction: number) => void
): PageChannel {
  const engine = resolvePageEngine(settings);
  if (engine === "browser") {
    return new OnDevicePageChannel(new OnDeviceTranslatorPool(settings.targetLanguage, onDownloadProgress));
  }
  return new BackgroundPageChannel(engine);
}

class BackgroundPageChannel implements PageChannel {
  readonly markup: boolean;
  readonly limits: PageBatchLimits;

  constructor(readonly engine: PageEngine) {
    this.markup = pageEngineSupportsMarkup(engine);
    this.limits = pageBatchLimits(engine);
  }

  async translate(
    texts: string[],
    source: LanguageTag,
    markup: boolean
  ): Promise<Array<string | null>> {
    const response = await safeRuntimeSendMessage<TextsTranslationResponse>({
      type: "TRANSLATE_TEXTS",
      texts,
      source,
      markup
    } satisfies ExtensionMessage);
    if (!response) {
      throw new PageChannelError("扩展已更新或后台没有响应，请刷新页面后重试。", "fatal");
    }
    if (!response.ok || !Array.isArray(response.texts)) {
      throw new PageChannelError(
        response.error ?? "翻译服务没有返回译文。",
        response.retryable ? "transient" : "fatal"
      );
    }
    const answered = response.texts;
    return texts.map((_, index) => {
      const text = answered[index];
      return typeof text === "string" ? text : null;
    });
  }

  destroy(): void {
    // The background owns its requests and their timeouts.
  }
}

class OnDevicePageChannel implements PageChannel {
  readonly engine: PageEngine = "browser";
  readonly markup = false;
  readonly limits = pageBatchLimits("browser");

  constructor(private readonly pool: OnDeviceTranslatorPool) {}

  async translate(texts: string[], source: LanguageTag): Promise<Array<string | null>> {
    const results: Array<string | null> = [];
    for (const text of texts) {
      try {
        results.push((await this.pool.translate(text, source)).trim() || null);
      } catch (error) {
        if (!(error instanceof OnDeviceTranslatorError)) {
          results.push(null);
          continue;
        }
        if (error.reason === "needs-activation") {
          throw new PageChannelError(error.message, "needs-activation");
        }
        if (error.reason === "unsupported") {
          throw new PageChannelError(
            `${error.message}可以在扩展设置里把「网页翻译通道」换成其他服务。`,
            "fatal"
          );
        }
        results.push(null);
      }
    }
    return results;
  }

  activate(): Promise<boolean> {
    return this.pool.activate();
  }

  destroy(): void {
    this.pool.destroy();
  }
}
