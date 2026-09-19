import { DEFAULT_SETTINGS, formatGlossary, parseGlossary } from "../shared/settings";
import type {
  ExtensionMessage,
  SaveSettingsResponse,
  SettingsResponse,
  TestTranslationResponse
} from "../shared/messages";
import type { TranslationSettings } from "../shared/types";

const form = byId<HTMLFormElement>("settings-form");
const provider = byId<HTMLSelectElement>("provider");
const model = byId<HTMLInputElement>("model");
const apiFields = byId<HTMLElement>("api-fields");
const apiBaseUrl = byId<HTMLInputElement>("api-base-url");
const apiKey = byId<HTMLInputElement>("api-key");
const toggleKey = byId<HTMLButtonElement>("toggle-key");
const websocketFields = byId<HTMLElement>("websocket-fields");
const websocketUrl = byId<HTMLInputElement>("websocket-url");
const position = byId<HTMLSelectElement>("position");
const showOriginal = byId<HTMLInputElement>("show-original-setting");
const draftCaptions = byId<HTMLInputElement>("draft-captions-setting");
const draftProvider = byId<HTMLSelectElement>("draft-provider");
const draftRemoteFields = byId<HTMLElement>("draft-remote-fields");
const draftEndpoint = byId<HTMLInputElement>("draft-endpoint");
const draftApiKey = byId<HTMLInputElement>("draft-api-key");
const localMtEnabled = byId<HTMLInputElement>("local-mt-enabled");
const localMtUrl = byId<HTMLInputElement>("local-mt-url");
const fontSize = byId<HTMLInputElement>("font-size");
const fontSizeOutput = byId<HTMLOutputElement>("font-size-output");
const opacity = byId<HTMLInputElement>("background-opacity");
const opacityOutput = byId<HTMLOutputElement>("opacity-output");
const glossary = byId<HTMLTextAreaElement>("glossary");
const saveButton = byId<HTMLButtonElement>("save-settings");
const testButton = byId<HTMLButtonElement>("test-connection");
const saveResult = byId<HTMLParagraphElement>("save-result");
const connectionResult = byId<HTMLParagraphElement>("connection-result");

void loadSettings();

provider.addEventListener("change", renderProviderFields);
draftProvider.addEventListener("change", renderProviderFields);
toggleKey.addEventListener("click", toggleApiKeyVisibility);
fontSize.addEventListener("input", renderRangeOutputs);
opacity.addEventListener("input", renderRangeOutputs);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void save(false);
});
testButton.addEventListener("click", () => void save(true));

async function loadSettings(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "GET_OPTIONS_SETTINGS"
    } satisfies ExtensionMessage)) as SettingsResponse;
    hydrate(response.settings as TranslationSettings);
    saveResult.textContent = "";
  } catch {
    saveResult.textContent = "无法读取设置。请重新打开此页面。";
    saveResult.dataset.state = "error";
  }
}

function hydrate(settings: TranslationSettings): void {
  provider.value = settings.provider;
  model.value = settings.model;
  apiBaseUrl.value = settings.apiBaseUrl;
  apiKey.value = settings.apiKey;
  websocketUrl.value = settings.webSocketUrl;
  position.value = settings.position;
  showOriginal.checked = settings.showOriginal;
  draftCaptions.checked = settings.draftCaptions;
  draftProvider.value = settings.draftProvider;
  draftEndpoint.value = settings.draftEndpointUrl;
  draftApiKey.value = settings.draftApiKey;
  localMtEnabled.checked = settings.localMtEnabled;
  localMtUrl.value = settings.localMtUrl;
  fontSize.value = String(settings.fontSizePx);
  opacity.value = String(settings.backgroundOpacity);
  glossary.value = formatGlossary(settings.glossary);
  renderProviderFields();
  renderRangeOutputs();
}

function renderProviderFields(): void {
  const selected = provider.value;
  apiFields.hidden = selected !== "openai-compatible";
  websocketFields.hidden = selected !== "websocket";
  draftRemoteFields.hidden = draftProvider.value === "browser";
  const modelField = model.closest<HTMLElement>(".field");
  if (modelField) {
    modelField.hidden = selected !== "openai-compatible";
  }
  testButton.textContent = selected === "mock" ? "保存并运行演示测试" : "保存并测试「こんにちは」";
}

function renderRangeOutputs(): void {
  fontSizeOutput.value = `${fontSize.value}px`;
  opacityOutput.value = `${Math.round(Number(opacity.value) * 100)}%`;
}

function toggleApiKeyVisibility(): void {
  const nextType = apiKey.type === "password" ? "text" : "password";
  apiKey.type = nextType;
  toggleKey.textContent = nextType === "password" ? "显示" : "隐藏";
  toggleKey.setAttribute("aria-label", nextType === "password" ? "显示 API Key" : "隐藏 API Key");
}

async function save(testAfterSave: boolean): Promise<void> {
  let settings: TranslationSettings;
  try {
    settings = buildSettings();
    await requestEndpointPermission(settings);
    await requestDraftPermission(settings);
    await requestLocalMtPermission(settings);
  } catch (error) {
    setSaveState(error instanceof Error ? error.message : "请检查填写内容。", "error");
    return;
  }

  setBusy(true);
  setSaveState("正在保存…", "pending");
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "SAVE_SETTINGS",
      patch: settings
    } satisfies ExtensionMessage)) as SaveSettingsResponse;
    if (!response.ok || !response.settings) {
      throw new Error(response.error ?? "无法保存设置。");
    }
    hydrate(response.settings);
    setSaveState("设置已保存。", "success");
    if (testAfterSave) {
      await testConnection(response.settings);
    }
  } catch (error) {
    setSaveState(error instanceof Error ? error.message : "无法保存设置。", "error");
  } finally {
    setBusy(false);
  }
}

function buildSettings(): TranslationSettings {
  const selectedProvider = provider.value as TranslationSettings["provider"];
  if (selectedProvider !== "openai-compatible" && selectedProvider !== "websocket" && selectedProvider !== "mock") {
    throw new Error("请选择可用的翻译服务类型。");
  }
  const apiEndpoint = validateUrl(apiBaseUrl.value, ["https:", "http:"], "API 地址");
  const wsEndpoint = validateUrl(websocketUrl.value, ["wss:", "ws:"], "WebSocket 地址");
  if (selectedProvider === "openai-compatible" && !model.value.trim()) {
    throw new Error("请填写翻译模型名称。");
  }
  return {
    enabled: true,
    provider: selectedProvider,
    apiBaseUrl: apiEndpoint,
    apiKey: apiKey.value.trim(),
    model: model.value.trim(),
    webSocketUrl: wsEndpoint,
    sourceLanguage: "ja",
    targetLanguage: "zh-CN",
    showOriginal: showOriginal.checked,
    fontSizePx: Number(fontSize.value),
    position: position.value as TranslationSettings["position"],
    backgroundOpacity: Number(opacity.value),
    glossary: parseGlossary(glossary.value),
    draftCaptions: draftCaptions.checked,
    draftProvider: draftProvider.value as TranslationSettings["draftProvider"],
    draftEndpointUrl: draftEndpoint.value.trim()
      ? validateUrl(draftEndpoint.value, ["https:", "http:"], "草稿翻译地址")
      : DEFAULT_SETTINGS.draftEndpointUrl,
    draftApiKey: draftApiKey.value.trim(),
    localMtEnabled: localMtEnabled.checked,
    localMtUrl: localMtUrl.value.trim()
      ? validateUrl(localMtUrl.value, ["https:", "http:"], "本机翻译地址")
      : DEFAULT_SETTINGS.localMtUrl
  };
}

function validateUrl(value: string, protocols: string[], label: string): string {
  try {
    const url = new URL(value.trim());
    if (!protocols.includes(url.protocol)) {
      throw new Error("protocol");
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${label}格式无效。`);
  }
}

async function requestEndpointPermission(settings: TranslationSettings): Promise<void> {
  if (settings.provider === "mock") {
    return;
  }
  const endpoint = settings.provider === "websocket" ? settings.webSocketUrl : settings.apiBaseUrl;
  const url = new URL(endpoint);
  const scheme = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
  const origin = `${scheme}//${url.host}/*`;
  const hasPermission = await chrome.permissions.contains({ origins: [origin] });
  if (hasPermission) {
    return;
  }
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) {
    throw new Error("未获得连接翻译服务的授权；设置没有保存。");
  }
}

/**
 * The draft endpoint is a separate host, so it needs its own grant. Without it
 * the background request would fail silently and the draft channel would look
 * broken rather than unauthorized.
 */
async function requestDraftPermission(settings: TranslationSettings): Promise<void> {
  if (!settings.draftCaptions || settings.draftProvider === "browser") {
    return;
  }
  const url = new URL(settings.draftEndpointUrl);
  const origin = `${url.protocol}//${url.host}/*`;
  if (await chrome.permissions.contains({ origins: [origin] })) {
    return;
  }
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) {
    throw new Error(`未获得连接 ${url.host} 的授权；草稿翻译无法启用。`);
  }
}

async function requestLocalMtPermission(settings: TranslationSettings): Promise<void> {
  if (!settings.localMtEnabled) {
    return;
  }
  const url = new URL(settings.localMtUrl);
  const origin = `${url.protocol}//${url.host}/*`;
  if (await chrome.permissions.contains({ origins: [origin] })) {
    return;
  }
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) {
    throw new Error(`未获得连接本机翻译服务 ${url.host} 的授权。`);
  }
}

async function testConnection(settings: TranslationSettings): Promise<void> {
  connectionResult.dataset.state = "pending";
  connectionResult.textContent = "正在发送测试请求…";
  const response = (await chrome.runtime.sendMessage({
    type: "TEST_TRANSLATION",
    settings
  } satisfies ExtensionMessage)) as TestTranslationResponse;
  if (!response.ok || !response.translation) {
    connectionResult.dataset.state = "error";
    connectionResult.textContent = response.error?.message ?? "测试失败。";
    return;
  }
  connectionResult.dataset.state = "success";
  connectionResult.textContent = `测试成功：${response.translation.text}`;
}

function setBusy(busy: boolean): void {
  saveButton.disabled = busy;
  testButton.disabled = busy;
}

function setSaveState(message: string, state: "pending" | "success" | "error"): void {
  saveResult.textContent = message;
  saveResult.dataset.state = state;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: ${id}`);
  }
  return element as T;
}
