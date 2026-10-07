import type {
  ExtensionMessage,
  PageCommand,
  PageCommandResponse,
  SaveSettingsResponse,
  SettingsResponse,
  TabStatusResponse
} from "../shared/messages";
import { languageLabel, languagePairLabel } from "../shared/language";
import { isMeetingHost, meetingFinalChannelLabel } from "../shared/meeting";
import { pageTextDestinationShort, pageTranslateChannelLabel } from "../shared/page-translation";
import { publicSettings } from "../shared/settings";
import type { PublicTranslationSettings, RuntimeStatus } from "../shared/types";

const enabledToggle = byId<HTMLButtonElement>("enabled-toggle");
const enabledLabel = byId<HTMLSpanElement>("enabled-label");
const languagePair = byId<HTMLParagraphElement>("language-pair");
const showOriginal = byId<HTMLInputElement>("show-original");
const meetingControls = byId<HTMLElement>("meeting-controls");
const meetingOverlayHidden = byId<HTMLInputElement>("meeting-overlay-hidden");
const meetingChannelNote = byId<HTMLSpanElement>("meeting-channel-note");
const statusDot = byId<HTMLSpanElement>("status-dot");
const runtimeMessage = byId<HTMLParagraphElement>("runtime-message");
const runtimeDetail = byId<HTMLParagraphElement>("runtime-detail");
const serviceName = byId<HTMLElement>("service-name");
const openOptions = byId<HTMLButtonElement>("open-options");
const enableHosts = byId<HTMLButtonElement>("enable-hosts");
const togglePage = byId<HTMLButtonElement>("toggle-page");
const openSidePanel = byId<HTMLButtonElement>("open-side-panel");
const pageChannelNote = byId<HTMLSpanElement>("page-channel-note");
const shortcutHint = byId<HTMLSpanElement>("shortcut-hint");

/** Every site, for the selection buttons; page translation itself only needs the tab in front. */
const ALL_SITES_ORIGINS = ["https://*/*", "http://*/*"];

let settings: PublicTranslationSettings | null = null;
/** True while the active tab is a meeting host, which unlocks the hide switch. */
let onMeetingTab = false;
let activeTab: chrome.tabs.Tab | null = null;
let pageTranslated = false;

void initialize();

enabledToggle.addEventListener("click", () => {
  if (!settings) {
    return;
  }
  void savePatch({ enabled: !settings.enabled });
});

showOriginal.addEventListener("change", () => {
  if (!settings) {
    return;
  }
  void savePatch({ showOriginal: showOriginal.checked });
});

// One click before sharing a screen: the overlay goes away, no meeting text is
// sent anywhere, and Meet's own captions come straight back.
meetingOverlayHidden.addEventListener("change", () => {
  if (!settings) {
    return;
  }
  void savePatch({ meetingOverlayHidden: meetingOverlayHidden.checked });
});

openOptions.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

enableHosts.addEventListener("click", () => {
  void enableEverySite();
});
togglePage.addEventListener("click", () => {
  void runPageCommand(pageTranslated ? "restore-page" : "translate-page");
});
openSidePanel.addEventListener("click", () => {
  // Opened straight from the click: Chrome only allows it in response to one.
  const windowId = activeTab?.windowId;
  if (windowId === undefined || typeof chrome.sidePanel?.open !== "function") {
    renderRuntime({
      state: "error",
      message: "这个 Chrome 版本不支持扩展侧边栏（需要 Chrome 116 或更新版本）。",
      updatedAt: Date.now()
    });
    return;
  }
  chrome.sidePanel.open({ windowId }).then(
    () => window.close(),
    (error: unknown) =>
      renderRuntime({
        state: "error",
        message: `无法打开侧边栏：${error instanceof Error ? error.message : "未知错误"}`,
        updatedAt: Date.now()
      })
  );
});

/**
 * The all-sites grant is asked for here, inside the user's click, where
 * Chrome shows its prompt naming "all sites". Registering the content script
 * is the worker's job; it also does it on its own if this popup closes while
 * the prompt is open.
 */
async function enableEverySite(): Promise<void> {
  try {
    const granted = await chrome.permissions.request({ origins: ALL_SITES_ORIGINS });
    if (!granted) {
      renderRuntime({ state: "error", message: "未获得访问所有网站的授权。", updatedAt: Date.now() });
      return;
    }
  } catch (error) {
    renderRuntime({
      state: "error",
      message: error instanceof Error ? error.message : "无法请求网站访问授权。",
      updatedAt: Date.now()
    });
    return;
  }
  await runPageCommand("ensure-hosts");
}

async function runPageCommand(command: PageCommand): Promise<void> {
  const busy = command === "translate-page" || command === "restore-page";
  if (busy) {
    togglePage.disabled = true;
    renderRuntime({
      state: "translating",
      message: command === "restore-page" ? "正在恢复原文…" : "正在开始翻译整页…",
      updatedAt: Date.now()
    });
  }
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "PAGE_COMMAND",
      command,
      tabId: activeTab?.id
    } satisfies ExtensionMessage)) as PageCommandResponse;
    if (typeof response.translated === "boolean") {
      renderPageState(response.translated);
    }
    renderRuntime({
      state: response.ok ? "ready" : "error",
      message: response.ok ? response.message ?? "完成" : response.error ?? "操作失败",
      updatedAt: Date.now()
    });
  } catch (error) {
    renderRuntime({
      state: "error",
      message: error instanceof Error ? error.message : "操作失败",
      updatedAt: Date.now()
    });
  } finally {
    togglePage.disabled = false;
  }
}

function renderPageState(translated: boolean): void {
  pageTranslated = translated;
  togglePage.textContent = translated ? "显示原文" : "翻译整页";
  togglePage.setAttribute("aria-pressed", String(translated));
}

async function loadPageState(): Promise<void> {
  if (activeTab?.id === undefined) {
    return;
  }
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "PAGE_COMMAND",
      command: "page-state",
      tabId: activeTab.id
    } satisfies ExtensionMessage)) as PageCommandResponse;
    renderPageState(response.translated === true);
  } catch {
    renderPageState(false);
  }
}

async function loadShortcut(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    const shortcut = commands.find((command) => command.name === "translate-page")?.shortcut;
    shortcutHint.textContent = shortcut
      ? `快捷键 ${shortcut} 翻译整页 / 显示原文`
      : "翻译整页的快捷键可在 chrome://extensions/shortcuts 设置";
  } catch {
    // The hint keeps its default text.
  }
}
async function initialize(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "GET_PUBLIC_SETTINGS"
    } satisfies ExtensionMessage)) as SettingsResponse;
    settings = response.settings as PublicTranslationSettings;
    renderSettings(settings);
    await loadRuntimeStatus();
  } catch {
    renderRuntime({
      state: "error",
      message: "无法读取扩展配置",
      updatedAt: Date.now()
    });
  }
}

async function loadRuntimeStatus(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab ?? null;
  void loadPageState();
  void loadShortcut();
  onMeetingTab = isMeetingTabUrl(tab?.url);
  if (settings) {
    renderSettings(settings);
  }
  if (tab?.id === undefined) {
    renderRuntime({
      state: "idle",
      message: "请打开一个视频页面或 Google Meet 会议",
      updatedAt: Date.now()
    });
    return;
  }
  const response = (await chrome.runtime.sendMessage({
    type: "GET_TAB_STATUS",
    tabId: tab.id
  } satisfies ExtensionMessage)) as TabStatusResponse;
  renderRuntime(
    response.status ?? {
      state: "searching",
      message: "正在等待受支持的视频页面连接",
      updatedAt: Date.now()
    }
  );
}

async function savePatch(patch: {
  enabled?: boolean;
  showOriginal?: boolean;
  meetingOverlayHidden?: boolean;
}): Promise<void> {
  if (!settings) {
    return;
  }
  enabledToggle.disabled = true;
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "SAVE_SETTINGS",
      patch
    } satisfies ExtensionMessage)) as SaveSettingsResponse;
    if (!response.ok || !response.settings) {
      throw new Error(response.error ?? "保存失败");
    }
    // Reuse the shared projection so every key stays stripped in one place.
    settings = publicSettings(response.settings);
    renderSettings(settings);
  } catch (error) {
    renderRuntime({
      state: "error",
      message: error instanceof Error ? error.message : "无法保存设置",
      updatedAt: Date.now()
    });
  } finally {
    enabledToggle.disabled = false;
  }
}

function renderSettings(nextSettings: PublicTranslationSettings): void {
  enabledToggle.setAttribute("aria-checked", String(nextSettings.enabled));
  enabledToggle.dataset.enabled = String(nextSettings.enabled);
  enabledLabel.textContent = nextSettings.enabled ? "已开启" : "已暂停";
  enabledToggle.setAttribute("aria-label", nextSettings.enabled ? "暂停翻译" : "开启翻译");
  showOriginal.checked = nextSettings.showOriginal;
  languagePair.textContent = languagePairLabel(
    nextSettings.sourceLanguage,
    nextSettings.targetLanguage
  );
  // The hide switch only means something on a meeting page, so it only appears
  // there rather than sitting inert on every other tab.
  meetingControls.hidden = !(onMeetingTab && nextSettings.meetingMode);
  meetingOverlayHidden.checked = nextSettings.meetingOverlayHidden;
  meetingChannelNote.textContent = `会议译文：${meetingFinalChannelLabel(
    nextSettings.meetingFinalChannel
  )}`;
  pageChannelNote.textContent = `${pageTranslateChannelLabel(
    nextSettings.pageTranslateChannel
  )} · ${pageTextDestinationShort(nextSettings)}`;

  if (nextSettings.provider === "mock") {
    serviceName.textContent = "演示翻译模式";
  } else if (!nextSettings.apiKeyConfigured) {
    serviceName.textContent = "尚未配置 API Key";
  } else if (nextSettings.provider === "websocket") {
    serviceName.textContent = "自定义 WebSocket";
  } else {
    serviceName.textContent = nextSettings.model;
  }
}

function renderRuntime(status: RuntimeStatus): void {
  statusDot.dataset.state = status.state;
  runtimeMessage.textContent = status.message;
  runtimeDetail.textContent = runtimeDetailFor(status);
}

function runtimeDetailFor(status: RuntimeStatus): string {
  if (status.state === "unavailable") {
    return "Tranlithion 只读取网页公开的文本字幕，不处理烧录字幕、会议音频或受保护内容。";
  }
  if (status.state === "error") {
    return "打开设置检查服务地址、API Key、网页翻译通道与网站访问授权。";
  }
  const latency = typeof status.latencyMs === "number"
    ? `完整译文 ${formatLatency(status.latencyMs)}；流式译文可能更早出现。`
    : "";
  if (status.source === "text-track") {
    return ["正在使用播放器字幕轨道。", latency].filter(Boolean).join(" ");
  }
  if (status.source === "youtube-dom") {
    return ["正在读取 YouTube 已显示的字幕。", latency].filter(Boolean).join(" ");
  }
  if (status.source === "netflix-dom") {
    return ["正在读取 Netflix 已显示的文本字幕。", latency].filter(Boolean).join(" ");
  }
  if (status.source === "meet-dom") {
    return ["正在读取 Google Meet 已显示的字幕，不读取会议音频。", latency]
      .filter(Boolean)
      .join(" ");
  }
  const sourceName = settings ? languageLabel(settings.sourceLanguage) : "源语言";
  return onMeetingTab
    ? "请在 Meet 底部工具栏点击「开启字幕」(CC)。"
    : `视频字幕：请在 YouTube 或 Netflix 播放器中开启${sourceName}字幕。网页翻译不需要字幕。`;
}

function isMeetingTabUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    return isMeetingHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function formatLatency(latencyMs: number): string {
  return `${(latencyMs / 1_000).toFixed(latencyMs >= 1_000 ? 1 : 2)} 秒`;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: ${id}`);
  }
  return element as T;
}
