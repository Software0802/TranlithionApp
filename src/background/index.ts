import {
  DEFAULT_SETTINGS,
  mergeSettings,
  normalizeSettings,
  publicSettings,
  SETTINGS_STORAGE_KEY
} from "../shared/settings";
import {
  isExtensionMessage,
  type DraftTranslationResponse,
  type ExtensionMessage,
  type PlainBatchTranslationResponse,
  type PlainTranslationResponse,
  type SettingsResponse,
  type TabStatusResponse,
  type TestTranslationResponse
} from "../shared/messages";
import {
  SessionJobQueue,
  SupersededJobError,
  TranslationSessionStore,
  type PersistedTranslationSession
} from "../shared/translation-session";
import type {
  RuntimeStatus,
  TabRuntimeStatus,
  SubtitleCue,
  TranslationFailure,
  TranslationResponse,
  TranslationSettings
} from "../shared/types";
import { translateDraft } from "./draft-translator";
import {
  translateBatchWithLibreTranslate,
  translateWithLibreTranslate
} from "./local-mt";
import { translateWithAgent, TranslatorError } from "./translator";

const SESSION_CONTEXT_STORAGE_KEY = "translation-session-context";
const TAB_STATUS_STORAGE_KEY = "tab-runtime-status";
const sessionStore = new TranslationSessionStore();
const jobQueue = new SessionJobQueue();
const tabStatuses = new Map<number, TabRuntimeStatus>();
/**
 * Draft requests cancel on their own timeline. They must not share the main
 * queue's controllers, or a superseded draft would abort the quality request
 * for the very caption it is meant to support.
 */
const draftControllers = new Map<string, AbortController>();
const hydratedSessionIds = new Set<string>();
let contextStorageQueue: Promise<void> = Promise.resolve();
let tabStatusStorageQueue: Promise<void> = Promise.resolve();
/** Hot-path cache: chrome.storage.local.get on every cue was adding tens of ms. */
let settingsCache: TranslationSettings | null = null;
let permissionCache:
  | { key: string; failure: TranslationFailure | null }
  | null = null;

chrome.runtime.onInstalled.addListener(() => {
  void initializeSettings();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeSettings();
});

void initializeSettings();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[SETTINGS_STORAGE_KEY]) {
    settingsCache = null;
    permissionCache = null;
    void broadcastPublicSettings();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStatuses.delete(tabId);
  void removePersistedTabStatus(tabId);
});

chrome.runtime.onMessage.addListener((rawMessage: unknown, sender, sendResponse) => {
  if (!isExtensionMessage(rawMessage)) {
    return false;
  }
  void handleMessage(rawMessage, sender).then(sendResponse).catch((error: unknown) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : "扩展发生未知错误。" });
  });
  return true;
});

async function handleMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender
): Promise<unknown> {
  switch (message.type) {
    case "GET_PUBLIC_SETTINGS": {
      const settings = await getSettings();
      return { settings: publicSettings(settings) } satisfies SettingsResponse;
    }
    case "GET_OPTIONS_SETTINGS": {
      const settings = await getSettings();
      return { settings } satisfies SettingsResponse;
    }
    case "SAVE_SETTINGS": {
      const settings = mergeSettings(await getSettings(), message.patch);
      settingsCache = settings;
      permissionCache = null;
      await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
      return { ok: true, settings };
    }
    case "GET_TAB_STATUS": {
      return {
        status: await getTabStatus(message.tabId)
      } satisfies TabStatusResponse;
    }
    case "REPORT_TAB_STATUS": {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) {
        await setTabStatus(tabId, message.status);
      }
      return { ok: true };
    }
    case "TRANSLATE_CUE": {
      return translateCue(message.request, sender.tab?.id);
    }
    case "DRAFT_TRANSLATE": {
      return draftTranslate(message.sessionId, message.text);
    }
    case "TRANSLATE_PLAIN": {
      return translatePlain(message.text);
    }
    case "TRANSLATE_PLAIN_BATCH": {
      return translatePlainBatch(message.texts);
    }
    case "PAGE_COMMAND": {
      return handlePageCommand(message.command, sender.tab?.id);
    }
    case "CLEAR_TRANSLATION_SESSION": {
      draftControllers.get(message.sessionId)?.abort();
      draftControllers.delete(message.sessionId);
      jobQueue.cancelLatest(message.sessionId);
      sessionStore.clear(message.sessionId);
      hydratedSessionIds.delete(message.sessionId);
      await removePersistedSession(message.sessionId);
      return { ok: true };
    }
    case "TEST_TRANSLATION": {
      return testTranslation(message.settings);
    }
    case "SETTINGS_UPDATED":
      return { ok: true };
    default:
      return { ok: false, error: "未知扩展消息。" };
  }
}

async function initializeSettings(): Promise<void> {
  await Promise.allSettled([
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  ]);
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  if (!stored[SETTINGS_STORAGE_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS });
    settingsCache = { ...DEFAULT_SETTINGS };
  } else {
    settingsCache = normalizeSettings(stored[SETTINGS_STORAGE_KEY]);
  }
}

async function getSettings(): Promise<TranslationSettings> {
  if (settingsCache) {
    return settingsCache;
  }
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  settingsCache = normalizeSettings(stored[SETTINGS_STORAGE_KEY]);
  return settingsCache;
}

async function translateCue(
  request: { sessionId: string; cue: SubtitleCue },
  tabId?: number
): Promise<TranslationResponse> {
  // Restore session memory without blocking the first cached/settings reads when
  // the session is already hydrated (common after the first caption).
  const hydrate = restorePersistedSession(request.sessionId);
  const settings = await getSettings();
  if (!settings.enabled) {
    await hydrate;
    return failure("NOT_CONFIGURED", "翻译已暂停。请在扩展弹窗中重新开启。");
  }

  const permissionFailure = await cachedPermissionFailure(settings);
  if (permissionFailure) {
    await hydrate;
    return { ok: false, error: permissionFailure };
  }

  await hydrate;

  const latestOnly = request.cue.source === "netflix-dom";
  const cached =
    sessionStore.getCached(request.sessionId, request.cue.id) ??
    (latestOnly
      ? sessionStore.getCachedByText(request.sessionId, request.cue.text)
      : undefined);
  // Netflix cue ids include startMs, so repeats only hit via text. Serving the
  // text cache immediately keeps live captions in sync without a network round-trip.
  if (cached) {
    if (latestOnly) {
      sessionStore.record(request.sessionId, request.cue, { ...cached, latencyMs: 0 });
    }
    return { ok: true, translation: { ...cached, latencyMs: 0 } };
  }

  if (tabId !== undefined) {
    // Persisting popup state must not delay the latency-critical API request.
    void setTabStatus(tabId, {
      state: "translating",
      message: "正在翻译当前字幕",
      source: request.cue.source,
      updatedAt: Date.now()
    }).catch(() => undefined);
  }

  const runTranslation = async (signal?: AbortSignal) => {
    const duplicate =
      sessionStore.getCached(request.sessionId, request.cue.id) ??
      (latestOnly
        ? sessionStore.getCachedByText(request.sessionId, request.cue.text)
        : undefined);
    if (duplicate) {
      return { ...duplicate, latencyMs: 0 };
    }
    const result = await translateWithAgent({
      cue: request.cue,
      settings,
      recentContext: sessionStore.getContext(request.sessionId),
      rememberedTerms: sessionStore.getEntityHints(request.sessionId),
      signal,
      onPartial: latestOnly && tabId !== undefined
        ? (text) => publishPartialTranslation(tabId, request.sessionId, request.cue.id, text)
        : undefined
    });
    if (signal?.aborted) {
      throw new TranslatorError("CANCELLED", "字幕已更新，已取消过期翻译。");
    }
    sessionStore.record(request.sessionId, request.cue, result);
    await persistSession(request.sessionId);
    return result;
  };

  try {
    const translation = latestOnly
      ? await jobQueue.enqueueLatest(request.sessionId, (signal) => runTranslation(signal))
      : await jobQueue.enqueue(request.sessionId, () => runTranslation());
    return { ok: true, translation };
  } catch (error) {
    const response = toFailure(error);
    if (isCancellation(error)) {
      return response;
    }
    if (tabId !== undefined) {
      await setTabStatus(tabId, {
        state: "error",
        message: response.error?.message ?? "翻译过程中发生未知错误。",
        source: request.cue.source,
        updatedAt: Date.now()
      });
    }
    return response;
  }
}

async function draftTranslate(
  sessionId: string,
  text: string
): Promise<DraftTranslationResponse> {
  const settings = await getSettings();
  if (!settings.enabled || !settings.draftCaptions || settings.draftProvider === "browser") {
    return { ok: false };
  }
  if (await requiredDraftPermissionMissing(settings)) {
    return { ok: false };
  }

  draftControllers.get(sessionId)?.abort();
  const controller = new AbortController();
  draftControllers.set(sessionId, controller);
  try {
    const translated = await translateDraft({ text, settings, signal: controller.signal });
    return translated && !controller.signal.aborted ? { ok: true, text: translated } : { ok: false };
  } finally {
    if (draftControllers.get(sessionId) === controller) {
      draftControllers.delete(sessionId);
    }
  }
}

async function translatePlain(text: string): Promise<PlainTranslationResponse> {
  const settings = await getSettings();
  if (!settings.enabled) {
    return { ok: false, error: "翻译已暂停。" };
  }
  if (!settings.localMtEnabled) {
    return { ok: false, error: "本机翻译服务未开启。请在选项中启用 LibreTranslate。" };
  }
  if (await localMtPermissionMissing(settings)) {
    return { ok: false, error: "尚未授权访问本机翻译服务地址。" };
  }
  const translated = await translateWithLibreTranslate(text, settings);
  return translated ? { ok: true, text: translated } : { ok: false, error: "本机翻译失败。请确认 LibreTranslate 已启动。" };
}

async function translatePlainBatch(texts: string[]): Promise<PlainBatchTranslationResponse> {
  const settings = await getSettings();
  if (!settings.enabled) {
    return { ok: false, error: "翻译已暂停。" };
  }
  if (!settings.localMtEnabled) {
    return { ok: false, error: "本机翻译服务未开启。" };
  }
  if (await localMtPermissionMissing(settings)) {
    return { ok: false, error: "尚未授权访问本机翻译服务地址。" };
  }
  const capped = texts.slice(0, 200);
  const results = await translateBatchWithLibreTranslate(capped, settings, 4);
  return {
    ok: true,
    texts: results.map((item, index) => item ?? capped[index] ?? "")
  };
}

async function localMtPermissionMissing(settings: TranslationSettings): Promise<boolean> {
  try {
    const url = new URL(settings.localMtUrl);
    return !(await chrome.permissions.contains({ origins: [`${url.protocol}//${url.host}/*`] }));
  } catch {
    return true;
  }
}

async function handlePageCommand(
  command: "translate-page" | "restore-page" | "ensure-hosts",
  tabId?: number
): Promise<{ ok: boolean; error?: string; message?: string }> {
  if (command === "ensure-hosts") {
    const granted = await chrome.permissions.request({
      origins: ["https://*/*", "http://*/*", "http://127.0.0.1/*", "http://localhost/*"]
    });
    if (!granted) {
      return { ok: false, error: "未获得网站访问授权。" };
    }
    try {
      await chrome.scripting.registerContentScripts([
        {
          id: "tranlithion-all-pages",
          matches: ["https://*/*", "http://*/*"],
          js: ["content/index.js"],
          runAt: "document_idle",
          persistAcrossSessions: true
        }
      ]);
    } catch {
      // Already registered from a previous grant.
    }
    return { ok: true, message: "全站权限已就绪，请刷新目标网页后再用。" };
  }

  if (tabId === undefined) {
    return { ok: false, error: "没有活动标签页。" };
  }
  try {
    const result = (await chrome.tabs.sendMessage(tabId, {
      type: "PAGE_COMMAND",
      command
    } satisfies ExtensionMessage)) as { ok?: boolean; message?: string; error?: string } | undefined;
    if (result && result.ok === false) {
      return { ok: false, error: result.error ?? result.message ?? "页面操作失败。" };
    }
    return { ok: true, message: result?.message };
  } catch {
    return { ok: false, error: "无法与当前页面通信。请刷新页面后重试，或先点击「启用全站」。" };
  }
}

async function requiredDraftPermissionMissing(settings: TranslationSettings): Promise<boolean> {
  try {
    const url = new URL(settings.draftEndpointUrl);
    return !(await chrome.permissions.contains({ origins: [`${url.protocol}//${url.host}/*`] }));
  } catch {
    return true;
  }
}

async function testTranslation(settingsCandidate: TranslationSettings): Promise<TestTranslationResponse> {
  const settings = normalizeSettings(settingsCandidate);
  const permissionFailure = await requiredPermissionFailure(settings);
  if (permissionFailure) {
    return { ok: false, error: permissionFailure };
  }
  try {
    const translation = await translateWithAgent({
      cue: {
        id: "connection-test",
        startMs: 0,
        endMs: 1_000,
        text: "こんにちは",
        isFinal: true,
        source: "text-track"
      },
      settings,
      recentContext: [],
      rememberedTerms: []
    });
    return { ok: true, translation };
  } catch (error) {
    return toFailure(error);
  }
}

async function cachedPermissionFailure(
  settings: TranslationSettings
): Promise<TranslationFailure | null> {
  const key = permissionCacheKey(settings);
  if (permissionCache?.key === key) {
    return permissionCache.failure;
  }
  const failure = await requiredPermissionFailure(settings);
  permissionCache = { key, failure };
  return failure;
}

function permissionCacheKey(settings: TranslationSettings): string {
  if (settings.provider === "mock") {
    return "mock";
  }
  if (settings.provider === "websocket") {
    return `ws:${settings.webSocketUrl}`;
  }
  return `openai:${settings.apiBaseUrl}:${settings.apiKey ? "key" : "nokey"}`;
}

async function requiredPermissionFailure(
  settings: TranslationSettings
): Promise<TranslationFailure | null> {
  if (settings.provider === "mock") {
    return null;
  }
  if (settings.provider === "openai-compatible" && !settings.apiKey) {
    return {
      code: "NOT_CONFIGURED",
      message: "尚未保存 API Key。请在扩展设置中完成翻译服务配置。"
    };
  }
  const endpoint = settings.provider === "websocket" ? settings.webSocketUrl : settings.apiBaseUrl;
  let pattern: string;
  try {
    const url = new URL(endpoint);
    const scheme = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
    pattern = `${scheme}//${url.host}/*`;
  } catch {
    return { code: "NOT_CONFIGURED", message: "翻译服务地址无效。" };
  }
  const allowed = await chrome.permissions.contains({ origins: [pattern] });
  if (!allowed) {
    return {
      code: "PERMISSION",
      message: `尚未授权连接到 ${new URL(endpoint).host}。请在设置中保存并允许该服务。`
    };
  }
  return null;
}

function failure(code: TranslationFailure["code"], message: string): TranslationResponse {
  return { ok: false, error: { code, message } };
}

function toFailure(error: unknown): TranslationResponse {
  if (error instanceof TranslatorError) {
    return failure(error.code, error.message);
  }
  return failure("UNKNOWN", "翻译过程中发生未知错误。请稍后重试。");
}

function isCancellation(error: unknown): boolean {
  return error instanceof SupersededJobError ||
    (error instanceof TranslatorError && error.code === "CANCELLED");
}

function publishPartialTranslation(
  tabId: number,
  sessionId: string,
  cueId: string,
  text: string
): void {
  void chrome.tabs.sendMessage(tabId, {
    type: "TRANSLATION_PARTIAL",
    sessionId,
    cueId,
    text
  } satisfies ExtensionMessage).catch(() => undefined);
}

async function getTabStatus(tabId: number): Promise<TabRuntimeStatus | null> {
  const inMemory = tabStatuses.get(tabId);
  if (inMemory) {
    return inMemory;
  }
  const stored = await chrome.storage.session.get(TAB_STATUS_STORAGE_KEY);
  const persisted = readPersistedTabStatuses(stored[TAB_STATUS_STORAGE_KEY])[String(tabId)];
  if (persisted) {
    tabStatuses.set(tabId, persisted);
  }
  return persisted ?? null;
}

async function setTabStatus(tabId: number, status: RuntimeStatus): Promise<void> {
  const completeStatus: TabRuntimeStatus = { ...status, tabId };
  tabStatuses.set(tabId, completeStatus);
  await queueTabStatusStorageUpdate(async () => {
    const stored = await chrome.storage.session.get(TAB_STATUS_STORAGE_KEY);
    const statuses = readPersistedTabStatuses(stored[TAB_STATUS_STORAGE_KEY]);
    statuses[String(tabId)] = completeStatus;
    await chrome.storage.session.set({ [TAB_STATUS_STORAGE_KEY]: statuses });
  });
}

async function removePersistedTabStatus(tabId: number): Promise<void> {
  await queueTabStatusStorageUpdate(async () => {
    const stored = await chrome.storage.session.get(TAB_STATUS_STORAGE_KEY);
    const statuses = readPersistedTabStatuses(stored[TAB_STATUS_STORAGE_KEY]);
    delete statuses[String(tabId)];
    await chrome.storage.session.set({ [TAB_STATUS_STORAGE_KEY]: statuses });
  });
}

function queueTabStatusStorageUpdate(update: () => Promise<void>): Promise<void> {
  const operation = tabStatusStorageQueue.then(update, update);
  tabStatusStorageQueue = operation.catch(() => undefined);
  return operation;
}

function readPersistedTabStatuses(value: unknown): Record<string, TabRuntimeStatus> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, status]) => isTabRuntimeStatus(status))
  ) as Record<string, TabRuntimeStatus>;
}

function isTabRuntimeStatus(value: unknown): value is TabRuntimeStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const status = value as TabRuntimeStatus;
  return (
    typeof status.tabId === "number" &&
    Number.isInteger(status.tabId) &&
    typeof status.state === "string" &&
    typeof status.message === "string" &&
    (status.latencyMs === undefined ||
      (typeof status.latencyMs === "number" && Number.isFinite(status.latencyMs) && status.latencyMs >= 0)) &&
    typeof status.updatedAt === "number" &&
    Number.isFinite(status.updatedAt)
  );
}

async function restorePersistedSession(sessionId: string): Promise<void> {
  if (hydratedSessionIds.has(sessionId)) {
    return;
  }
  const stored = await chrome.storage.session.get(SESSION_CONTEXT_STORAGE_KEY);
  const sessions = readPersistedSessions(stored[SESSION_CONTEXT_STORAGE_KEY]);
  sessionStore.restore(sessionId, sessions[sessionId]);
  hydratedSessionIds.add(sessionId);
}

async function persistSession(sessionId: string): Promise<void> {
  const snapshot = sessionStore.snapshot(sessionId);
  if (!snapshot) {
    return;
  }
  await queueContextStorageUpdate(async () => {
    const stored = await chrome.storage.session.get(SESSION_CONTEXT_STORAGE_KEY);
    const sessions = readPersistedSessions(stored[SESSION_CONTEXT_STORAGE_KEY]);
    sessions[sessionId] = snapshot;
    const retained = Object.entries(sessions)
      .sort(([, left], [, right]) => right.lastTouchedAt - left.lastTouchedAt)
      .slice(0, 12);
    await chrome.storage.session.set({
      [SESSION_CONTEXT_STORAGE_KEY]: Object.fromEntries(retained)
    });
  });
}

async function removePersistedSession(sessionId: string): Promise<void> {
  await queueContextStorageUpdate(async () => {
    const stored = await chrome.storage.session.get(SESSION_CONTEXT_STORAGE_KEY);
    const sessions = readPersistedSessions(stored[SESSION_CONTEXT_STORAGE_KEY]);
    delete sessions[sessionId];
    await chrome.storage.session.set({ [SESSION_CONTEXT_STORAGE_KEY]: sessions });
  });
}

function queueContextStorageUpdate(update: () => Promise<void>): Promise<void> {
  const operation = contextStorageQueue.then(update, update);
  contextStorageQueue = operation.catch(() => undefined);
  return operation;
}

function readPersistedSessions(value: unknown): Record<string, PersistedTranslationSession> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, session]) =>
      typeof session === "object" && session !== null && !Array.isArray(session)
    )
  ) as Record<string, PersistedTranslationSession>;
}

async function broadcastPublicSettings(): Promise<void> {
  const message: ExtensionMessage = {
    type: "SETTINGS_UPDATED",
    settings: publicSettings(await getSettings())
  };
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.flatMap((tab) =>
      tab.id === undefined
        ? []
        : [chrome.tabs.sendMessage(tab.id, message).catch(() => undefined)]
    )
  );
}
