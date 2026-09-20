import { DEFAULT_SETTINGS, formatGlossary, parseGlossary } from "../shared/settings";
import {
  normalizeLanguagePair,
  normalizeLanguageTag,
  sampleSourceText
} from "../shared/language";
import { MEETING_HOST_PERMISSIONS, meetingTextDestination } from "../shared/meeting";
import { describeTranscriptSummary } from "../shared/meeting-transcript";
import type {
  ExtensionMessage,
  MeetingTranscriptResponse,
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
const sourceLanguage = byId<HTMLSelectElement>("source-language");
const targetLanguage = byId<HTMLSelectElement>("target-language");
const showOriginal = byId<HTMLInputElement>("show-original-setting");
const meetingMode = byId<HTMLInputElement>("meeting-mode");
const meetingFinalChannel = byId<HTMLSelectElement>("meeting-final-channel");
const meetingMascot = byId<HTMLInputElement>("meeting-mascot");
const meetingOverlayHidden = byId<HTMLInputElement>("meeting-overlay-hidden");
const meetingTranscript = byId<HTMLInputElement>("meeting-transcript");
const meetingRetention = byId<HTMLSelectElement>("meeting-retention");
const meetingDestination = byId<HTMLParagraphElement>("meeting-destination");
const enableMeetingHosts = byId<HTMLButtonElement>("enable-meeting-hosts");
const meetingPermissionResult = byId<HTMLParagraphElement>("meeting-permission-result");
const clearTranscripts = byId<HTMLButtonElement>("clear-transcripts");
const transcriptSummary = byId<HTMLParagraphElement>("transcript-summary");
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
void loadTranscriptSummary();

provider.addEventListener("change", renderProviderFields);
draftProvider.addEventListener("change", renderProviderFields);
draftCaptions.addEventListener("change", renderProviderFields);
meetingFinalChannel.addEventListener("change", renderProviderFields);
sourceLanguage.addEventListener("change", renderLanguagePair);
targetLanguage.addEventListener("change", renderLanguagePair);
// D7: the disclosure names a host read from these fields, so it has to follow
// them as they are typed — otherwise it keeps naming the previous service.
for (const field of [draftEndpoint, localMtUrl, apiBaseUrl, websocketUrl, model]) {
  field.addEventListener("input", renderMeetingDestination);
}
toggleKey.addEventListener("click", toggleApiKeyVisibility);
fontSize.addEventListener("input", renderRangeOutputs);
opacity.addEventListener("input", renderRangeOutputs);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void save(false);
});
testButton.addEventListener("click", () => void save(true));
enableMeetingHosts.addEventListener("click", () => void grantMeetingHosts());
clearTranscripts.addEventListener("click", () => void wipeTranscripts());

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
  sourceLanguage.value = settings.sourceLanguage;
  targetLanguage.value = settings.targetLanguage;
  showOriginal.checked = settings.showOriginal;
  meetingMode.checked = settings.meetingMode;
  meetingFinalChannel.value = settings.meetingFinalChannel;
  meetingMascot.checked = settings.meetingMascot;
  meetingOverlayHidden.checked = settings.meetingOverlayHidden;
  meetingTranscript.checked = settings.meetingTranscript;
  meetingRetention.value = String(settings.meetingTranscriptRetentionDays);
  if (!meetingRetention.value) {
    // A stored value with no matching option would read back as empty and
    // silently reset the user's retention window on the next save.
    meetingRetention.value = String(DEFAULT_SETTINGS.meetingTranscriptRetentionDays);
  }
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
  const sample = sampleSourceText(
    normalizeLanguageTag(sourceLanguage.value, DEFAULT_SETTINGS.sourceLanguage)
  );
  testButton.textContent = selected === "mock" ? "保存并运行演示测试" : `保存并测试「${sample}」`;
  renderMeetingDestination();
}

/**
 * The two language selects are independent, so the user can pick a pair that
 * asks a provider to translate a line into the language it is already in.
 * Correct it in place, visibly, rather than letting the save silently rewrite it.
 */
function renderLanguagePair(): void {
  const pair = normalizeLanguagePair(
    normalizeLanguageTag(sourceLanguage.value, DEFAULT_SETTINGS.sourceLanguage),
    normalizeLanguageTag(targetLanguage.value, DEFAULT_SETTINGS.targetLanguage)
  );
  sourceLanguage.value = pair.source;
  targetLanguage.value = pair.target;
  renderMeetingDestination();
}

/** D7: name the service that will receive what people say in the meeting. */
function renderMeetingDestination(): void {
  meetingDestination.textContent = meetingTextDestination({
    meetingFinalChannel: meetingFinalChannel.value as TranslationSettings["meetingFinalChannel"],
    draftCaptions: draftCaptions.checked,
    draftProvider: draftProvider.value as TranslationSettings["draftProvider"],
    draftEndpointUrl: draftEndpoint.value || DEFAULT_SETTINGS.draftEndpointUrl,
    localMtUrl: localMtUrl.value || DEFAULT_SETTINGS.localMtUrl,
    provider: provider.value as TranslationSettings["provider"],
    apiBaseUrl: apiBaseUrl.value || DEFAULT_SETTINGS.apiBaseUrl,
    webSocketUrl: websocketUrl.value || DEFAULT_SETTINGS.webSocketUrl,
    model: model.value
  });
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
  if (meetingMode.checked && meetingFinalChannel.value === "local-mt" && !localMtEnabled.checked) {
    throw new Error("会议译文通道选择了本机 LibreTranslate，请同时勾选下方「启用本机 LibreTranslate」。");
  }
  const languages = normalizeLanguagePair(
    normalizeLanguageTag(sourceLanguage.value, DEFAULT_SETTINGS.sourceLanguage),
    normalizeLanguageTag(targetLanguage.value, DEFAULT_SETTINGS.targetLanguage)
  );
  return {
    enabled: true,
    provider: selectedProvider,
    apiBaseUrl: apiEndpoint,
    apiKey: apiKey.value.trim(),
    model: model.value.trim(),
    webSocketUrl: wsEndpoint,
    sourceLanguage: languages.source,
    targetLanguage: languages.target,
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
      : DEFAULT_SETTINGS.localMtUrl,
    meetingMode: meetingMode.checked,
    meetingFinalChannel: meetingFinalChannel.value as TranslationSettings["meetingFinalChannel"],
    meetingMascot: meetingMascot.checked,
    meetingOverlayHidden: meetingOverlayHidden.checked,
    meetingTranscript: meetingTranscript.checked,
    meetingTranscriptRetentionDays: Number(meetingRetention.value)
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
  // Meeting mode can use this endpoint as its only translator, so the grant is
  // needed even when draft captions themselves are switched off.
  const usedByMeeting = settings.meetingMode && settings.meetingFinalChannel === "fast-mt";
  if ((!settings.draftCaptions && !usedByMeeting) || settings.draftProvider === "browser") {
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

/**
 * Meeting hosts are an optional permission, granted from here so the user sees
 * the exact domain Chrome is being asked about. The content script is
 * registered only after the grant.
 */
async function grantMeetingHosts(): Promise<void> {
  enableMeetingHosts.disabled = true;
  meetingPermissionResult.dataset.state = "pending";
  meetingPermissionResult.textContent = "正在请求 meet.google.com 访问授权…";
  try {
    // Requested here, not in the worker: `permissions.request` needs the user
    // gesture that belongs to this click.
    const origins = [...MEETING_HOST_PERMISSIONS];
    if (!(await chrome.permissions.contains({ origins }))) {
      const granted = await chrome.permissions.request({ origins });
      if (!granted) {
        meetingPermissionResult.dataset.state = "error";
        meetingPermissionResult.textContent = "未获得访问 meet.google.com 的授权。";
        return;
      }
    }
    const response = (await chrome.runtime.sendMessage({
      type: "PAGE_COMMAND",
      command: "enable-meeting-hosts"
    } satisfies ExtensionMessage)) as { ok: boolean; message?: string; error?: string };
    meetingPermissionResult.dataset.state = response.ok ? "success" : "error";
    meetingPermissionResult.textContent = response.ok
      ? response.message ?? "已启用。"
      : response.error ?? "授权失败。";
  } catch (error) {
    meetingPermissionResult.dataset.state = "error";
    meetingPermissionResult.textContent =
      error instanceof Error ? error.message : "授权失败。";
  } finally {
    enableMeetingHosts.disabled = false;
  }
}

async function loadTranscriptSummary(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({
      type: "GET_MEETING_TRANSCRIPTS"
    } satisfies ExtensionMessage)) as MeetingTranscriptResponse;
    const summary = response.summary;
    if (!summary) {
      transcriptSummary.dataset.state = "success";
      transcriptSummary.textContent = "本机当前没有保存任何会议记录。";
      return;
    }
    const described = describeTranscriptSummary(summary);
    transcriptSummary.dataset.state = described.state;
    transcriptSummary.textContent = described.text;
  } catch {
    transcriptSummary.dataset.state = "error";
    transcriptSummary.textContent = "无法读取会议记录状态。";
  }
}

async function wipeTranscripts(): Promise<void> {
  clearTranscripts.disabled = true;
  try {
    await chrome.runtime.sendMessage({
      type: "CLEAR_MEETING_TRANSCRIPTS"
    } satisfies ExtensionMessage);
    transcriptSummary.dataset.state = "success";
    transcriptSummary.textContent = "已清除本机保存的全部会议记录。";
  } catch {
    transcriptSummary.dataset.state = "error";
    transcriptSummary.textContent = "清除失败，请重试。";
  } finally {
    clearTranscripts.disabled = false;
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
