import {
  isExtensionMessage,
  type ExtensionMessage,
  type PageCommand,
  type SettingsResponse
} from "../shared/messages";
import {
  isExtensionContextInvalidatedError,
  isExtensionContextValid,
  safeRuntimeSendMessage
} from "../shared/extension-context";
import type {
  PublicTranslationSettings,
  RuntimeStatus,
  SubtitleCue,
  TranslationResponse
} from "../shared/types";
import { isMeetingModeActive } from "../shared/meeting";
import { SelectionMascot } from "./mascot";
import { PageTranslator } from "./page-translator";
import { SubtitleController, type CaptionTarget } from "./subtitle-controller";

class TranslationContentApp {
  private settings: PublicTranslationSettings | null = null;
  private controller: SubtitleController | null = null;
  private observer: MutationObserver | null = null;
  private scanTimer: number | null = null;
  private url = location.href;
  private stopped = false;
  private readonly pageTranslator = new PageTranslator();
  private mascot: SelectionMascot | null = null;

  async start(): Promise<void> {
    this.settings = await this.loadPublicSettings();
    if (!this.settings || this.stopped) {
      return;
    }
    if (!isExtensionContextValid()) {
      this.stop();
      return;
    }

    try {
      chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
        try {
          if (!isExtensionContextValid()) {
            this.stop();
            return false;
          }
          if (!isExtensionMessage(message)) {
            return false;
          }
          if (message.type === "SETTINGS_UPDATED") {
            const wasMeeting = this.meetingModeActive();
            this.settings = message.settings;
            if (this.meetingModeActive() !== wasMeeting) {
              // Meeting mode changes which adapter, clock, and overlay anchor
              // the page needs, so the controller is rebuilt rather than patched.
              this.controller?.destroy();
              this.controller = null;
              this.scan();
            } else {
              this.controller?.updateSettings(message.settings);
            }
            this.syncMascot();
            return false;
          }
          if (message.type === "TRANSLATION_PARTIAL") {
            this.controller?.showPartialTranslation(
              message.sessionId,
              message.cueId,
              message.text
            );
            return false;
          }
          if (message.type === "PAGE_COMMAND") {
            void this.handlePageCommand(message.command).then(sendResponse, () => {
              sendResponse({ ok: false, error: "扩展上下文已失效，请刷新页面。" });
            });
            return true;
          }
          return false;
        } catch (error) {
          if (isExtensionContextInvalidatedError(error)) {
            this.stop();
            return false;
          }
          throw error;
        }
      });
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        this.stop();
        return;
      }
      throw error;
    }

    // Orphan content scripts after extension reload: swallow the Chrome error
    // and tear down so Netflix observers stop hammering a dead runtime.
    window.addEventListener("unhandledrejection", this.onUnhandledRejection);
    window.addEventListener("error", this.onWindowError);
    this.syncMascot();
    this.observer = new MutationObserver(() => this.scheduleScan());
    this.observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("pagehide", this.stop, { once: true });
    this.scan();
  }

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

  private syncMascot(): void {
    // The mascot stays out of meetings unless the user asks for it: the page is
    // routinely inside a shared screen, where a floating sprite is everyone's
    // problem rather than the user's choice.
    const allowedHere = !this.meetingModeActive() || Boolean(this.settings?.meetingMascot);
    const enabled = Boolean(
      this.settings?.enabled && this.settings.localMtEnabled && allowedHere
    );
    if (enabled && !this.mascot) {
      this.mascot = new SelectionMascot();
      return;
    }
    if (!enabled && this.mascot) {
      this.mascot.destroy();
      this.mascot = null;
    }
  }

  private async handlePageCommand(
    command: PageCommand
  ): Promise<{ ok: boolean; message?: string; error?: string }> {
    if (command === "ensure-hosts" || command === "enable-meeting-hosts") {
      // Permission grants and script registration happen in the background.
      return { ok: true };
    }
    if (command === "restore-page") {
      const result = this.pageTranslator.restorePage();
      this.reportStatus({
        state: "ready",
        message: result.message,
        updatedAt: Date.now()
      });
      return { ok: result.ok, message: result.message };
    }
    this.reportStatus({
      state: "translating",
      message: "正在全页翻译…",
      updatedAt: Date.now()
    });
    const result = await this.pageTranslator.translatePage();
    this.reportStatus({
      state: result.ok ? "ready" : "error",
      message: result.message,
      updatedAt: Date.now()
    });
    return { ok: result.ok, message: result.message, error: result.ok ? undefined : result.message };
  }

  private readonly stop = (): void => {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    window.removeEventListener("unhandledrejection", this.onUnhandledRejection);
    window.removeEventListener("error", this.onWindowError);
    this.observer?.disconnect();
    this.observer = null;
    if (this.scanTimer !== null) {
      window.clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    this.mascot?.destroy();
    this.mascot = null;
    this.controller?.destroy();
    this.controller = null;
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
      // Non-video pages still support selection mascot + full-page commands.
      if (!this.controller) {
        this.reportStatus({
          state: "ready",
          message: "可全页翻译或选中文字（本机 LibreTranslate）",
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

void new TranslationContentApp().start().catch(() => undefined);
