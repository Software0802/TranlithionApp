import {
  isExtensionMessage,
  type ExtensionMessage,
  type PageCommand,
  type PageCommandResponse,
  type PageTranslationBadgeState,
  type SettingsResponse,
  type TextsTranslationResponse
} from "../shared/messages";
import {
  isExtensionContextInvalidatedError,
  isExtensionContextValid,
  safeRuntimeSendMessage
} from "../shared/extension-context";
import type { LanguageTag } from "../shared/language";
import { isMeetingModeActive } from "../shared/meeting";
import {
  detectTextLanguage,
  emptyScriptTally,
  pageLanguageContext,
  tallyScripts
} from "../shared/page-translation";
import { translateSelectedText } from "../shared/selection-translation";
import { OnDeviceTranslatorPool } from "../shared/translator-api";
import type {
  PublicTranslationSettings,
  RuntimeStatus,
  SubtitleCue,
  TranslationResponse
} from "../shared/types";
import { createPageChannel } from "./page/channels";
import { PageStatusPill } from "./page/page-status";
import { PageTranslator, type PageTranslationView } from "./page/page-translator";
import { SelectionToolbar, type SelectionTranslation } from "./selection-toolbar";
import { SubtitleController, type CaptionTarget } from "./subtitle-controller";

/**
 * The running app in this page's isolated world. The background injects the
 * content script on demand (for a page translation the user asked for) into
 * tabs that may already have it from the manifest or the all-sites
 * registration; a second copy must not start a second app.
 */
const INSTANCE_KEY = "__tranlithionContentApp";
/**
 * After the extension reloads, a newly injected copy runs in a fresh world and
 * cannot see the old one. It announces itself on the shared DOM instead, and
 * an old copy whose extension context is gone puts the page back and stops.
 */
const REPLACED_EVENT = "tranlithion:content-replaced";

interface RunningApp {
  alive(): boolean;
}

class TranslationContentApp implements RunningApp {
  private settings: PublicTranslationSettings | null = null;
  private controller: SubtitleController | null = null;
  private observer: MutationObserver | null = null;
  private scanTimer: number | null = null;
  private url = location.href;
  private stopped = false;
  private readonly ready: Promise<void>;
  private markReady: () => void = () => undefined;
  private pageTranslator: PageTranslator | null = null;
  private pageStatus: PageStatusPill | null = null;
  private selectionToolbar: SelectionToolbar | null = null;
  private selectionPool: OnDeviceTranslatorPool | null = null;
  private lastBadge: PageTranslationBadgeState = "idle";
  private lastPagePhase: PageTranslationView["phase"] = "idle";
  private reportedPageReady = false;

  constructor() {
    this.ready = new Promise((resolve) => {
      this.markReady = resolve;
    });
  }

  alive(): boolean {
    return !this.stopped && isExtensionContextValid();
  }

  start(): void {
    try {
      // Listening comes first: a copy injected on demand is sent its command
      // as soon as the script has run, before settings have loaded.
      chrome.runtime.onMessage.addListener(this.onMessage);
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        this.stop();
        return;
      }
      throw error;
    }
    document.dispatchEvent(new CustomEvent(REPLACED_EVENT));
    document.addEventListener(REPLACED_EVENT, this.onReplaced);
    void this.run().catch(() => undefined);
  }

  private async run(): Promise<void> {
    this.settings = await this.loadPublicSettings();
    this.markReady();
    if (!this.settings || this.stopped) {
      return;
    }
    if (!isExtensionContextValid()) {
      this.stop();
      return;
    }

    // Orphan content scripts after extension reload: swallow the Chrome error
    // and tear down so Netflix observers stop hammering a dead runtime.
    window.addEventListener("unhandledrejection", this.onUnhandledRejection);
    window.addEventListener("error", this.onWindowError);
    this.syncSelectionToolbar();
    this.observer = new MutationObserver(() => this.scheduleScan());
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("pagehide", this.stop, { once: true });
    this.scan();
  }

  private readonly onMessage = (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ): boolean => {
    try {
      if (!isExtensionContextValid()) {
        this.stop();
        return false;
      }
      if (!isExtensionMessage(message)) {
        return false;
      }
      if (message.type === "PING") {
        sendResponse({ ok: !this.stopped });
        return false;
      }
      if (message.type === "PAGE_COMMAND") {
        void this.ready
          .then(() => this.handlePageCommand(message.command))
          .then(sendResponse, () => {
            sendResponse({ ok: false, error: "扩展上下文已失效，请刷新页面。" });
          });
        return true;
      }
      if (!this.settings) {
        return false;
      }
      if (message.type === "SETTINGS_UPDATED") {
        this.applySettings(message.settings);
        return false;
      }
      if (message.type === "TRANSLATION_PARTIAL") {
        this.controller?.showPartialTranslation(message.sessionId, message.cueId, message.text);
      }
      return false;
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        this.stop();
        return false;
      }
      throw error;
    }
  };

  private applySettings(next: PublicTranslationSettings): void {
    const wasMeeting = this.meetingModeActive();
    const previousTarget = this.settings?.targetLanguage;
    this.settings = next;
    if (this.meetingModeActive() !== wasMeeting) {
      // Meeting mode changes which adapter, clock, and overlay anchor the page
      // needs, so the controller is rebuilt rather than patched.
      this.controller?.destroy();
      this.controller = null;
      this.scan();
    } else {
      this.controller?.updateSettings(next);
    }
    if (previousTarget !== next.targetLanguage) {
      this.selectionPool?.destroy();
      this.selectionPool = null;
    }
    this.pageTranslator?.updateSettings(next);
    this.syncSelectionToolbar();
  }

  private readonly onReplaced = (): void => {
    if (!isExtensionContextValid()) {
      this.stop();
    }
  };

  private readonly onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    if (!isExtensionContextInvalidatedError(event.reason)) {
      return;
    }
    event.preventDefault();
    this.stop();
  };

  private readonly onWindowError = (event: ErrorEvent): void => {
    if (!isExtensionContextInvalidatedError(event.error ?? event.message)) {
      return;
    }
    event.preventDefault();
    this.stop();
  };

  private meetingModeActive(): boolean {
    return Boolean(this.settings && isMeetingModeActive(this.settings, location.hostname));
  }

  /* ------------------------------------------------- page translation */

  private handlePageCommand(command: PageCommand): PageCommandResponse {
    if (command === "ensure-hosts" || command === "enable-meeting-hosts") {
      // Permission grants and script registration happen in the background.
      return { ok: true };
    }
    if (!this.settings || this.stopped) {
      return { ok: false, error: "无法读取扩展设置，请刷新页面后重试。" };
    }
    if (command === "page-state") {
      const translator = this.pageTranslator;
      return {
        ok: true,
        translated: translator?.isActive() ?? false,
        message: translator?.isActive() ? translator.view().message : undefined
      };
    }
    if (command === "restore-page") {
      if (!this.pageTranslator?.isActive()) {
        return { ok: true, translated: false, message: "这个页面没有被翻译。" };
      }
      this.pageTranslator.restore();
      return { ok: true, translated: false, message: "已恢复原文。" };
    }
    const translator = this.ensurePageTranslator(this.settings);
    const view = command === "toggle-page" ? translator.toggle() : translator.start();
    return {
      ok: view.phase !== "error",
      translated: translator.isActive(),
      message: view.message,
      error: view.phase === "error" ? view.message : undefined
    };
  }

  private ensurePageTranslator(settings: PublicTranslationSettings): PageTranslator {
    if (this.pageTranslator) {
      return this.pageTranslator;
    }
    this.pageStatus = new PageStatusPill({
      restore: () => this.pageTranslator?.restore(),
      retry: () => this.pageTranslator?.retry(),
      activate: () => void this.pageTranslator?.activate()
    });
    this.pageTranslator = new PageTranslator(settings, {
      root: () => document.body,
      langAttribute: () => document.documentElement.getAttribute("lang"),
      createChannel: (current) =>
        createPageChannel(current, (fraction) => this.showModelDownload(fraction)),
      onChange: (view) => this.onPageView(view)
    });
    return this.pageTranslator;
  }

  private showModelDownload(fraction: number): void {
    if (!this.pageTranslator?.isActive() || fraction >= 1) {
      return;
    }
    this.pageStatus?.render({
      ...this.pageTranslator.view(),
      phase: "working",
      message: `正在下载 Chrome 本地翻译模型…${Math.round(fraction * 100)}%（只需下载一次）`
    });
  }

  private onPageView(view: PageTranslationView): void {
    if (this.stopped) {
      return;
    }
    this.pageStatus?.render(view);
    const badge: PageTranslationBadgeState =
      view.phase === "settled"
        ? view.translated > 0
          ? "translated"
          : "idle"
        : view.phase === "working" || view.phase === "needs-activation"
          ? "working"
          : view.phase === "error"
            ? "error"
            : "idle";
    if (badge !== this.lastBadge) {
      this.lastBadge = badge;
      void safeRuntimeSendMessage({
        type: "PAGE_TRANSLATION_STATE",
        state: badge
      } satisfies ExtensionMessage);
    }
    if (view.phase !== this.lastPagePhase) {
      this.lastPagePhase = view.phase;
      this.reportStatus({
        state: view.phase === "error" ? "error" : view.phase === "working" ? "translating" : "ready",
        message: view.message,
        updatedAt: Date.now()
      });
    }
  }

  /* --------------------------------------------------------- selection */

  private syncSelectionToolbar(): void {
    const settings = this.settings;
    // The buttons stay out of meetings unless the user asks for them: the page
    // is routinely inside a shared screen, where anything floating over it is
    // everyone's problem rather than the user's choice.
    const allowedHere = !this.meetingModeActive() || Boolean(settings?.meetingSelectionToolbar);
    const enabled = Boolean(settings?.enabled && settings.selectionToolbar && allowedHere);
    if (enabled && !this.selectionToolbar) {
      this.selectionToolbar = new SelectionToolbar({
        detect: (text, anchor) => this.detectSelection(text, anchor),
        target: () => this.settings?.targetLanguage ?? "zh-CN",
        translate: (text, source) => this.translateSelection(text, source),
        showInSidePanel: (text, source) => this.showInSidePanel(text, source)
      });
      return;
    }
    if (!enabled && this.selectionToolbar) {
      this.selectionToolbar.destroy();
      this.selectionToolbar = null;
    }
  }

  /** The selection's language, judged with the text around it for bare Han characters. */
  private detectSelection(text: string, anchor: Node): LanguageTag | null {
    const target = this.settings?.targetLanguage;
    const tally = emptyScriptTally();
    tallyScripts(tally, text);
    let around: Element | null = anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement;
    for (let step = 0; step < 4 && around?.parentElement; step += 1) {
      if ((around.textContent?.length ?? 0) > 200) {
        break;
      }
      around = around.parentElement;
    }
    tallyScripts(tally, (around?.textContent ?? "").slice(0, 4_000));
    const source = detectTextLanguage(
      text,
      pageLanguageContext({ langAttribute: document.documentElement.getAttribute("lang"), tally })
    );
    return source && source !== target ? source : null;
  }

  private async translateSelection(
    text: string,
    source: LanguageTag
  ): Promise<SelectionTranslation> {
    const settings = this.settings;
    if (!settings) {
      return { ok: false, error: "无法读取扩展设置，请刷新页面后重试。" };
    }
    const deps = {
      pool: () => (this.selectionPool ??= new OnDeviceTranslatorPool(settings.targetLanguage)),
      send: (message: ExtensionMessage) => safeRuntimeSendMessage<TextsTranslationResponse>(message)
    };
    let result = await translateSelectedText(text, source, settings, deps);
    // This runs inside the user's click, which is what Chrome was waiting for.
    if (!result.ok && result.needsActivation && (await deps.pool().activate([source]))) {
      result = await translateSelectedText(text, source, settings, deps);
    }
    return result.ok
      ? { ok: true, text: result.text, engineLabel: result.engineLabel }
      : { ok: false, error: result.error };
  }

  private async showInSidePanel(
    text: string,
    source: LanguageTag
  ): Promise<{ ok: boolean; error?: string }> {
    const response = await safeRuntimeSendMessage<{ ok: boolean; error?: string }>({
      type: "SHOW_IN_SIDE_PANEL",
      text,
      source
    } satisfies ExtensionMessage);
    return response ?? { ok: false, error: "扩展已更新，请刷新页面后重试。" };
  }

  /* -------------------------------------------------------- lifecycle */

  private readonly stop = (): void => {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.markReady();
    window.removeEventListener("unhandledrejection", this.onUnhandledRejection);
    window.removeEventListener("error", this.onWindowError);
    document.removeEventListener(REPLACED_EVENT, this.onReplaced);
    try {
      chrome.runtime.onMessage.removeListener(this.onMessage);
    } catch {
      // The runtime is already gone with the extension context.
    }
    this.observer?.disconnect();
    this.observer = null;
    if (this.scanTimer !== null) {
      window.clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    this.selectionToolbar?.destroy();
    this.selectionToolbar = null;
    this.selectionPool?.destroy();
    this.selectionPool = null;
    // Puts the page's own text back: nothing will be here to undo it later.
    this.pageTranslator?.destroy();
    this.pageTranslator = null;
    this.pageStatus?.destroy();
    this.pageStatus = null;
    this.controller?.destroy();
    this.controller = null;
    const scope = globalThis as unknown as Record<string, unknown>;
    if (scope[INSTANCE_KEY] === this) {
      delete scope[INSTANCE_KEY];
    }
  };

  private scheduleScan(): void {
    if (this.stopped || this.scanTimer !== null) {
      return;
    }
    this.scanTimer = window.setTimeout(() => {
      this.scanTimer = null;
      this.scan();
    }, 180);
  }

  private scan(): void {
    if (this.stopped || !this.settings) {
      return;
    }
    if (!isExtensionContextValid()) {
      this.stop();
      return;
    }
    if (location.href !== this.url) {
      this.url = location.href;
      this.controller?.destroy();
      this.controller = null;
    }
    if (this.meetingModeActive()) {
      // A meeting page has many participant tiles and no video that tracks the
      // conversation, so the controller is anchored to the page, not to one of
      // them. Rebuilding it on every tile change would restart the session.
      if (this.controller?.target.kind !== "page") {
        this.controller?.destroy();
        this.controller = this.createController({ kind: "page" });
      }
      return;
    }

    const video = findPrimaryVideo();
    if (!video) {
      // Pages without a player still have page and selection translation.
      // Said once: this scan runs on every batch of DOM changes.
      if (!this.controller && !this.reportedPageReady && !this.pageTranslator?.isActive()) {
        this.reportedPageReady = true;
        this.reportStatus({
          state: "ready",
          message: "可以翻译整页，或选中文字后选择「翻译」/「侧边栏」",
          updatedAt: Date.now()
        });
      }
      return;
    }
    if (this.controller?.target.kind === "video" && this.controller.target.video === video) {
      return;
    }
    this.controller?.destroy();
    this.controller = this.createController({ kind: "video", video });
  }

  private createController(target: CaptionTarget): SubtitleController | null {
    if (!this.settings) {
      return null;
    }
    const controller = new SubtitleController(
      target,
      this.settings,
      (cue) => this.translateCue(cue),
      (status) => this.reportStatus(status)
    );
    controller.start();
    return controller;
  }

  private async loadPublicSettings(): Promise<PublicTranslationSettings | null> {
    const response = await safeRuntimeSendMessage<SettingsResponse>({
      type: "GET_PUBLIC_SETTINGS"
    } satisfies ExtensionMessage);
    const settings = response?.settings;
    if (!settings || !("apiKeyConfigured" in settings)) {
      return null;
    }
    return settings;
  }

  private async translateCue(cue: SubtitleCue): Promise<TranslationResponse> {
    if (!isExtensionContextValid()) {
      this.stop();
      return {
        ok: false,
        error: {
          code: "NETWORK",
          message: "扩展已更新，请刷新页面后重试。"
        }
      };
    }
    try {
      const response = await safeRuntimeSendMessage<TranslationResponse>({
        type: "TRANSLATE_CUE",
        request: { sessionId: this.controller?.sessionId ?? "orphan", cue }
      } satisfies ExtensionMessage);
      if (!response) {
        this.stop();
        return {
          ok: false,
          error: {
            code: "NETWORK",
            message: "扩展已更新，请刷新页面后重试。"
          }
        };
      }
      return response;
    } catch {
      return {
        ok: false,
        error: {
          code: "NETWORK",
          message: "无法联系扩展后台；请刷新页面后重试。"
        }
      };
    }
  }

  private reportStatus(status: RuntimeStatus): void {
    if (!isExtensionContextValid()) {
      this.stop();
      return;
    }
    void safeRuntimeSendMessage({
      type: "REPORT_TAB_STATUS",
      status
    } satisfies ExtensionMessage)
      .then((response) => {
        if (response === undefined && !isExtensionContextValid()) {
          this.stop();
        }
      })
      .catch(() => {
        this.stop();
      });
  }
}

function findPrimaryVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll("video"));
  return videos
    .filter((video) => {
      const rect = video.getBoundingClientRect();
      return rect.width >= 160 && rect.height >= 90;
    })
    .sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
    })[0] ?? null;
}

const scope = globalThis as unknown as Record<string, RunningApp | undefined>;
if (!scope[INSTANCE_KEY]?.alive()) {
  const app = new TranslationContentApp();
  scope[INSTANCE_KEY] = app;
  app.start();
}
