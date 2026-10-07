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
  type MeetingTranscriptResponse,
  type PageCommand,
  type PageCommandResponse,
  type PageTranslationBadgeState,
  type PlainTranslationResponse,
  type SettingsResponse,
  type SidePanelEntry,
  type SidePanelInboxResponse,
  type TabStatusResponse,
  type TestTranslationResponse,
  type TextsTranslationResponse
} from "../shared/messages";
import { isLanguageTag, sampleSourceText, type LanguageTag } from "../shared/language";
import {
  PAGE_MAX_ITEM_CHARS,
  PAGE_MAX_REQUEST_CHARS,
  PAGE_MAX_REQUEST_ITEMS,
  resolvePageEngine
} from "../shared/page-translation";
import {
  isMeetingHost,
  keepsSpokenRecord,
  speakerEntityHints,
  MEETING_CONTENT_SCRIPT_ID,
  MEETING_HOST_PERMISSIONS
} from "../shared/meeting";
import {
  appendTranscriptLine,
  expiredTranscriptKeys,
  isTranscriptSessionKey,
  MEETING_TRANSCRIPT_FAILURE_KEY,
  MEETING_TRANSCRIPT_PRUNED_AT_KEY,
  readTranscriptFailures,
  readTranscriptSession,
  readTranscriptSessions,
  retainedTranscriptFailures,
  summarizeTranscripts,
  transcriptPruneDue,
  transcriptSessionKey,
  type TranscriptFailure
} from "../shared/meeting-transcript";
import {
  SessionJobQueue,
  SupersededJobError,
  TranslationSessionStore,
  type PersistedTranslationSession
} from "../shared/translation-session";
import { applyTerminology, mergeTerminology } from "../shared/terminology";
import type {
  GlossaryEntry,
  RuntimeStatus,
  TabRuntimeStatus,
  SubtitleCue,
  TranslationFailure,
  TranslationResponse,
  TranslationResult,
  TranslationSettings
} from "../shared/types";
import { CuePrefetcher } from "./cue-prefetcher";
import { translateDraft } from "./draft-translator";
import { translateWithLibreTranslate } from "./local-mt";
import {
  clearPageTranslationCache,
  PageTranslationError,
  translatePageTexts
} from "./page-translation";
import {
  translateWithAgent,
  TranslatorError,
  warmUpEndpoint,
  warmUpTranslator
} from "./translator";

const SESSION_CONTEXT_STORAGE_KEY = "translation-session-context";
const TAB_STATUS_STORAGE_KEY = "tab-runtime-status";
/** Dynamic registration created by the popup's "在所有网站启用划词" button. */
const ALL_PAGES_CONTENT_SCRIPT_ID = "tranlithion-all-pages";
const ALL_SITES_ORIGINS = ["https://*/*", "http://*/*"];
const MENU_TRANSLATE_PAGE = "tranlithion-translate-page";
const MENU_SELECTION_SIDE_PANEL = "tranlithion-selection-side-panel";
/** Selections waiting for the side panel to finish opening. */
const SIDE_PANEL_INBOX_LIMIT = 10;
const SIDE_PANEL_INBOX_TTL_MS = 2 * 60_000;
/** Longest selection the side panel takes in one entry. */
const SIDE_PANEL_MAX_CHARS = PAGE_MAX_ITEM_CHARS;
/** How far ahead of playback one prefetch request may reach. */
const MAX_PREFETCH_CUES = 5;
/** A line longer than this is not a subtitle; it is not sent ahead of time. */
const MAX_PREFETCH_CUE_LENGTH = 500;
const sessionStore = new TranslationSessionStore();
const jobQueue = new SessionJobQueue();
const prefetcher = new CuePrefetcher(prefetchCue);
/** The line each session is translating live, which a prefetch never asks for again. */
const liveCueIds = new Map<string, string>();
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
let transcriptStorageQueue: Promise<void> = Promise.resolve();
/** Meetings already told the user their transcript could not be stored. */
const transcriptStorageFailures = new Set<string>();
/** Hot-path cache: chrome.storage.local.get on every cue was adding tens of ms. */
let settingsCache: TranslationSettings | null = null;
let permissionCache:
  | { key: string; failure: TranslationFailure | null }
  | null = null;
const sidePanelInbox: SidePanelEntry[] = [];

chrome.runtime.onInstalled.addListener(() => {
  void initializeSettings().then(pruneStoredTranscripts);
  installContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  void initializeSettings().then(pruneStoredTranscripts);
  installContextMenus();
});

void initializeSettings().then(pruneStoredTranscripts);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[SETTINGS_STORAGE_KEY]) {
    settingsCache = null;
    permissionCache = null;
    clearPageTranslationCache();
    void broadcastPublicSettings();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabStatuses.delete(tabId);
  void removePersistedTabStatus(tabId);
});

// Registered defensively: every entry point below is optional in older
// Chrome builds, and a missing one must not take the caption path down.
chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  // A navigation leaves the translated page behind, and its badge with it.
  if (changeInfo.status === "loading") {
    setPageBadge(tabId, "idle");
  }
});

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_SELECTION_SIDE_PANEL) {
    void showSelectionInSidePanel(info.selectionText ?? "", null, tab);
    return;
  }
  if (info.menuItemId === MENU_TRANSLATE_PAGE && tab?.id !== undefined) {
    void runPageCommandInTab("toggle-page", tab.id);
  }
});

chrome.commands?.onCommand.addListener((command, tab) => {
  if (command === "translate-page" && tab?.id !== undefined) {
    void runPageCommandInTab("toggle-page", tab.id);
  }
});

// The popup asks for the all-sites grant itself, from the user's click. Its
// window can close while Chrome shows the prompt, so the registration that
// the grant allows happens here, whenever the grant arrives.
chrome.permissions?.onAdded?.addListener((permissions) => {
  if (permissions.origins?.some((origin) => ALL_SITES_ORIGINS.includes(origin))) {
    void registerAllPagesScript();
  }
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
      const previous = await getSettings();
      const settings = mergeSettings(previous, message.patch);
      settingsCache = settings;
      permissionCache = null;
      await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
      if (previous.meetingTranscript && !settings.meetingTranscript) {
        await forgetMeetingRecords();
      }
      if (
        previous.meetingTranscriptRetentionDays !== settings.meetingTranscriptRetentionDays
      ) {
        // Retention is a privacy control: a window the user just shortened
        // applies on the next wake rather than after the sweep's interval.
        await forgetTranscriptPruneMarker();
      }
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
    case "PREFETCH_CUES": {
      return prefetchCues(message.sessionId, message.cues);
    }
    case "WARM_UP_TRANSLATOR": {
      // Nothing waits on this: the answer only says the request was heard.
      void warmUpTranslationServices(message.model === true, message.draft === true);
      return { ok: true };
    }
    case "DRAFT_TRANSLATE": {
      return draftTranslate(
        message.sessionId,
        message.text,
        message.asFinal === true,
        message.meeting === true
      );
    }
    case "RECORD_MEETING_LINE": {
      return recordMeetingLine(message, sender.tab?.id);
    }
    case "GET_MEETING_TRANSCRIPTS": {
      return meetingTranscriptSummary();
    }
    case "CLEAR_MEETING_TRANSCRIPTS": {
      await clearStoredTranscripts();
      return { ok: true };
    }
    case "TRANSLATE_PLAIN": {
      return translatePlain(message.text, message.sessionId);
    }
    case "TRANSLATE_TEXTS": {
      return translateTexts(message.texts, message.source, message.markup === true);
    }
    case "SHOW_IN_SIDE_PANEL": {
      // Nothing may be awaited before the panel is asked to open: Chrome only
      // allows it while the click that sent this message counts as a gesture.
      return showSelectionInSidePanel(message.text, message.source ?? null, sender.tab);
    }
    case "GET_SIDE_PANEL_INBOX": {
      return { entries: takeSidePanelEntries(message.windowId) } satisfies SidePanelInboxResponse;
    }
    case "PAGE_TRANSLATION_STATE": {
      if (sender.tab?.id !== undefined) {
        setPageBadge(sender.tab.id, message.state);
      }
      return { ok: true };
    }
    case "PAGE_COMMAND": {
      // The popup is not a tab, so it names the one it acts on.
      return handlePageCommand(message.command, message.tabId ?? sender.tab?.id);
    }
    case "CLEAR_TRANSLATION_SESSION": {
      draftControllers.get(message.sessionId)?.abort();
      draftControllers.delete(message.sessionId);
      jobQueue.cancelLatest(message.sessionId);
      prefetcher.clear(message.sessionId);
      liveCueIds.delete(message.sessionId);
      sessionStore.clear(message.sessionId);
      hydratedSessionIds.delete(message.sessionId);
      transcriptStorageFailures.delete(message.sessionId);
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
  const receivedAt = performance.now();
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
  sessionStore.useLanguagePair(
    request.sessionId,
    settings.sourceLanguage,
    settings.targetLanguage
  );
  if (request.cue.source === "meet-dom") {
    sessionStore.markMeetingSession(request.sessionId);
  }

  // A line the viewer has already read again, or one prefetched ahead of
  // playback, goes straight back. Page-rendered cue ids include the moment the
  // line appeared, so their repeats only hit via text.
  const cached =
    sessionStore.getCached(request.sessionId, request.cue.id) ??
    sessionStore.getCachedByText(request.sessionId, request.cue.text);
  if (cached) {
    await rememberTranslation(request.sessionId, request.cue, { ...cached, latencyMs: 0 });
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

  const runTranslation = async (signal: AbortSignal) => {
    // A prefetch already working on this line is waited for, not repeated.
    const prefetch = prefetcher.claim(request.sessionId, request.cue.id);
    if (prefetch) {
      await Promise.race([prefetch, whenAborted(signal)]);
      if (signal.aborted) {
        throw new TranslatorError("CANCELLED", "字幕已更新，已取消过期翻译。");
      }
      await throwIfPairChanged(settings);
    }
    const duplicate =
      sessionStore.getCached(request.sessionId, request.cue.id) ??
      sessionStore.getCachedByText(request.sessionId, request.cue.text);
    if (duplicate) {
      return { ...duplicate, latencyMs: Math.round(performance.now() - receivedAt) };
    }
    liveCueIds.set(request.sessionId, request.cue.id);
    let result: TranslationResult;
    try {
      result = await translateWithAgent({
        cue: request.cue,
        settings,
        recentContext: sessionStore.getContext(request.sessionId),
        rememberedTerms: sessionStore.getEntityHints(request.sessionId),
        signal,
        onPartial: tabId !== undefined
          ? (text) => publishPartialTranslation(tabId, request.sessionId, request.cue.id, text)
          : undefined
      });
    } finally {
      if (liveCueIds.get(request.sessionId) === request.cue.id) {
        liveCueIds.delete(request.sessionId);
      }
    }
    if (signal.aborted) {
      throw new TranslatorError("CANCELLED", "字幕已更新，已取消过期翻译。");
    }
    await throwIfPairChanged(settings);
    if (await rememberTranslation(request.sessionId, request.cue, result)) {
      // Storage only carries the context across a worker restart; the caption
      // is not held back while it is written.
      void persistSession(request.sessionId).catch(() => undefined);
    }
    return result;
  };

  try {
    // Every source is a live caption: a line the viewer has moved past is never
    // painted, so the newest request cancels the one before it rather than
    // queueing behind it and falling further behind with every line.
    const translation = await jobQueue.enqueueLatest(request.sessionId, runTranslation);
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

/**
 * Puts a finished translation into the session's memory under the consent the
 * user gave for this call, and says whether it is worth persisting.
 *
 * A meeting the user has not asked to keep leaves only what it taught us: the
 * terms stay for the rest of the session, the sentences and the names that
 * said them are never written into the context that reaches storage.
 */
async function rememberTranslation(
  sessionId: string,
  cue: SubtitleCue,
  result: TranslationResult
): Promise<boolean> {
  // Consent as it stands at the moment of writing, not as it stood when the
  // request left: a translation can be in flight for seconds, and what counts
  // is the answer the user has given by the time it lands.
  const settings = await getSettings();
  if (cue.source === "meet-dom") {
    // Writing a spoken line is what makes a session a call — including when
    // the write re-creates a session a withdrawal of consent has just
    // deleted, which must still be a call the next withdrawal can reach.
    sessionStore.markMeetingSession(sessionId);
  }
  if (!keepsSpokenRecord(settings, cue.source)) {
    sessionStore.rememberText(sessionId, cue.text, result);
    return false;
  }
  sessionStore.record(sessionId, cue, result);
  return true;
}

/** Everything a caption channel should render consistently: settings plus what the call taught us. */
function sessionTerminology(sessionId: string, settings: TranslationSettings): GlossaryEntry[] {
  return mergeTerminology(settings.glossary, sessionStore.getEntityHints(sessionId));
}

/**
 * Queues the next lines of a text track for translation ahead of playback.
 *
 * Only a text track is prefetched: its lines are known before they are shown,
 * where a page's rendered captions are not. The lines come from the track the
 * viewer is playing; nothing is read that the page did not expose.
 */
async function prefetchCues(sessionId: string, cues: unknown): Promise<{ ok: boolean }> {
  const settings = await getSettings();
  // The offline demo answers instantly, so there is nothing to get ahead of.
  if (!settings.enabled || settings.provider === "mock") {
    return { ok: false };
  }
  if (await cachedPermissionFailure(settings)) {
    return { ok: false };
  }
  await restorePersistedSession(sessionId);
  sessionStore.useLanguagePair(sessionId, settings.sourceLanguage, settings.targetLanguage);
  const wanted = (Array.isArray(cues) ? cues : [])
    .filter(isPrefetchableCue)
    .slice(0, MAX_PREFETCH_CUES);
  prefetcher.schedule(sessionId, wanted, (cue) => isAnswered(sessionId, cue));
  return { ok: true };
}

/** Translated already, or being translated live for the caption on screen. */
function isAnswered(sessionId: string, cue: SubtitleCue): boolean {
  return (
    sessionStore.getCached(sessionId, cue.id) !== undefined ||
    liveCueIds.get(sessionId) === cue.id
  );
}

/**
 * Translates one line ahead of playback into the session, exactly as the
 * live request for it would: with the context and names so far, and recorded
 * into the context the next line is translated with.
 */
async function prefetchCue(
  sessionId: string,
  cue: SubtitleCue,
  signal: AbortSignal
): Promise<void> {
  if (isAnswered(sessionId, cue)) {
    return;
  }
  const settings = await getSettings();
  if (!settings.enabled || signal.aborted) {
    return;
  }
  // Queued before a language switch, it is translated under the new pair,
  // with none of the old pair's context.
  sessionStore.useLanguagePair(sessionId, settings.sourceLanguage, settings.targetLanguage);
  const result = await translateWithAgent({
    cue,
    settings,
    recentContext: sessionStore.getContext(sessionId),
    rememberedTerms: sessionStore.getEntityHints(sessionId),
    signal
  });
  const current = await getSettings();
  // Written in a language the user has since switched away from, it would
  // come back later as a caption in the wrong language.
  if (
    signal.aborted ||
    current.sourceLanguage !== settings.sourceLanguage ||
    current.targetLanguage !== settings.targetLanguage
  ) {
    return;
  }
  if (await rememberTranslation(sessionId, cue, result)) {
    void persistSession(sessionId).catch(() => undefined);
  }
}

function isPrefetchableCue(value: unknown): value is SubtitleCue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const cue = value as SubtitleCue;
  return (
    cue.source === "text-track" &&
    typeof cue.id === "string" &&
    typeof cue.text === "string" &&
    cue.text.trim().length > 0 &&
    cue.text.length <= MAX_PREFETCH_CUE_LENGTH &&
    typeof cue.startMs === "number" &&
    Number.isFinite(cue.startMs)
  );
}

/**
 * Opens the connections a page's captions are about to use. Without the
 * user's grant for a service's origin nothing is sent to it, not even a
 * request without a body.
 */
async function warmUpTranslationServices(model: boolean, draft: boolean): Promise<void> {
  const settings = await getSettings();
  if (!settings.enabled) {
    return;
  }
  const warmUps: Promise<void>[] = [];
  if (model && !(await cachedPermissionFailure(settings))) {
    warmUps.push(warmUpTranslator(settings));
  }
  if (
    draft &&
    settings.draftProvider !== "browser" &&
    !(await requiredDraftPermissionMissing(settings))
  ) {
    warmUps.push(warmUpEndpoint(settings.draftEndpointUrl));
  }
  await Promise.all(warmUps);
}

/**
 * A request asked under a language pair the user has since left is over: its
 * answer is in the wrong language, and remembering it would serve that
 * language back later — from the cache, with nothing left to correct it.
 */
async function throwIfPairChanged(askedWith: TranslationSettings): Promise<void> {
  const current = await getSettings();
  if (
    current.sourceLanguage !== askedWith.sourceLanguage ||
    current.targetLanguage !== askedWith.targetLanguage
  ) {
    throw new TranslatorError("CANCELLED", "语言设置已更改，已取消旧语言的翻译。");
  }
}

/** Settles when the signal aborts; never rejects. */
function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function draftTranslate(
  sessionId: string,
  text: string,
  asFinal: boolean,
  meeting: boolean
): Promise<DraftTranslationResponse> {
  const settings = await getSettings();
  if (!settings.enabled || settings.draftProvider === "browser") {
    return { ok: false };
  }
  // In meeting mode this channel *is* the caption, so the draft-captions
  // preference must not silently switch it off.
  if (!settings.draftCaptions && !asFinal) {
    return { ok: false };
  }
  if (await requiredDraftPermissionMissing(settings)) {
    return { ok: false };
  }
  sessionStore.useLanguagePair(sessionId, settings.sourceLanguage, settings.targetLanguage);
  if (meeting) {
    // What is said in a call is what a withdrawn record consent must reach.
    // An episode on DeepL alone is a final caption too, but not a call.
    sessionStore.markMeetingSession(sessionId);
  }

  // As the caption itself this channel carries a whole meeting or episode,
  // where the same sentence comes round again and again. What the session
  // already learned is both faster and cheaper than asking a second time.
  const remembered = asFinal ? sessionStore.getCachedByText(sessionId, text) : undefined;
  if (remembered) {
    return { ok: true, text: remembered.text };
  }

  draftControllers.get(sessionId)?.abort();
  const controller = new AbortController();
  draftControllers.set(sessionId, controller);
  try {
    const translated = await translateDraft({
      text,
      settings,
      signal: controller.signal,
      asFinal,
      terminology: sessionTerminology(sessionId, settings)
    });
    if (!translated || controller.signal.aborted) {
      return { ok: false };
    }
    if (asFinal) {
      sessionStore.rememberText(sessionId, text, {
        text: translated,
        provider: settings.provider,
        latencyMs: 0,
        entityHints: []
      });
    }
    return { ok: true, text: translated };
  } finally {
    if (draftControllers.get(sessionId) === controller) {
      draftControllers.delete(sessionId);
    }
  }
}

/**
 * Records one settled meeting line: into session memory, so repeated terms and
 * speaker names stay consistent and repeats hit the cache, and into the
 * retention-limited local transcript when the user has it on (D7).
 *
 * The content script can reach this only for a meeting host, and nothing here
 * hands it anything back beyond an acknowledgement.
 */
async function recordMeetingLine(
  message: {
    sessionId: string;
    host: string;
    title: string;
    cue: SubtitleCue;
    translation: string;
  },
  tabId?: number
): Promise<{ ok: boolean }> {
  const translation = message.translation.trim();
  if (!isMeetingHost(message.host) || message.cue.source !== "meet-dom" || !translation) {
    return { ok: false };
  }
  const settings = await getSettings();
  await restorePersistedSession(message.sessionId);
  sessionStore.useLanguagePair(
    message.sessionId,
    settings.sourceLanguage,
    settings.targetLanguage
  );
  sessionStore.markMeetingSession(message.sessionId);

  // Speaker names are exactly the proper nouns a meeting keeps repeating, so
  // they join the session's term memory and reach every channel's rendering.
  const entityHints = speakerEntityHints(message.cue.speaker, settings.glossary);

  const recorded = await rememberTranslation(message.sessionId, message.cue, {
    text: translation,
    provider: settings.provider,
    latencyMs: 0,
    entityHints
  });
  if (recorded) {
    await persistSession(message.sessionId);
  }

  // Read again rather than trusting the snapshot this line arrived with: the
  // user may have unchecked the box while it was being translated.
  const consent = await getSettings();
  if (!consent.meetingTranscript) {
    return { ok: true };
  }

  await queueTranscriptStorageUpdate(async () => {
    // Only this meeting's own key is read and written, so one sentence never
    // pays to serialize every meeting on record.
    const key = transcriptSessionKey(message.sessionId);
    const stored = await chrome.storage.local.get(key);
    const current = readTranscriptSession(stored[key]);
    const next = appendTranscriptLine(current, {
      sessionId: message.sessionId,
      host: message.host,
      title: message.title,
      atMs: Date.now(),
      speaker: message.cue.speaker ?? null,
      source: message.cue.text,
      translation
    });
    if (!next || next === current) {
      return;
    }
    try {
      await chrome.storage.local.set({ [key]: next });
    } catch (error) {
      await reportTranscriptStorageFailure(message.sessionId, tabId, error);
      return;
    }
    if (!current) {
      // A meeting starts: this is the moment to enforce retention and the
      // session cap, rather than on every line of it.
      await dropExpiredTranscripts(consent.meetingTranscriptRetentionDays);
    }
  });
  return { ok: true };
}

async function meetingTranscriptSummary(): Promise<MeetingTranscriptResponse> {
  const settings = await getSettings();
  return {
    ok: true,
    summary: summarizeTranscripts({
      stored: await chrome.storage.local.get(null),
      nowMs: Date.now(),
      retentionDays: settings.meetingTranscriptRetentionDays
    })
  };
}

/**
 * `sessionId` is present when this is a caption channel rather than a one-off
 * page or selection translation: a meeting repeats itself, so the session's
 * memory answers the second time a sentence is said.
 */
async function translatePlain(
  text: string,
  sessionId?: string
): Promise<PlainTranslationResponse> {
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
  if (sessionId) {
    sessionStore.useLanguagePair(sessionId, settings.sourceLanguage, settings.targetLanguage);
    sessionStore.markMeetingSession(sessionId);
  }
  const remembered = sessionId ? sessionStore.getCachedByText(sessionId, text) : undefined;
  if (remembered) {
    return { ok: true, text: remembered.text };
  }
  const translated = await translateWithLibreTranslate(text, settings);
  if (!translated) {
    return { ok: false, error: "本机翻译失败。请确认 LibreTranslate 已启动。" };
  }
  if (!sessionId) {
    return { ok: true, text: translated };
  }
  const caption = applyTerminology(translated, sessionTerminology(sessionId, settings));
  sessionStore.rememberText(sessionId, text, {
    text: caption,
    provider: settings.provider,
    latencyMs: 0,
    entityHints: []
  });
  return { ok: true, text: caption };
}

/**
 * Page and selection text, translated by the page channel from the language
 * the page showed it in into the configured target language.
 */
async function translateTexts(
  rawTexts: unknown,
  rawSource: unknown,
  markup: boolean
): Promise<TextsTranslationResponse> {
  const settings = await getSettings();
  if (!settings.enabled) {
    return { ok: false, error: "翻译已暂停。请在扩展弹窗中重新开启。" };
  }
  const texts = readPageTexts(rawTexts);
  if (!texts || !isLanguageTag(rawSource)) {
    return { ok: false, error: "页面发来的翻译请求格式不正确。" };
  }
  const source: LanguageTag = rawSource;
  const target = settings.targetLanguage;
  if (source === target) {
    return { ok: true, texts };
  }
  const blocked = await pageChannelProblem(settings);
  if (blocked) {
    return { ok: false, error: blocked };
  }
  try {
    const translated = await translatePageTexts({ texts, source, target, markup, settings });
    // Answers are cached under the pair they were asked in, so the cache is
    // never wrong; but a page that asked in a language the user has since
    // left gets nothing back to paint.
    if ((await getSettings()).targetLanguage !== target) {
      return { ok: false, error: "语言设置已更改，已丢弃旧语言的译文。", retryable: true };
    }
    return { ok: true, texts: translated };
  } catch (error) {
    if (error instanceof PageTranslationError) {
      return { ok: false, error: error.message, retryable: error.retryable };
    }
    return { ok: false, error: "翻译过程中发生未知错误。", retryable: true };
  }
}

function readPageTexts(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > PAGE_MAX_REQUEST_ITEMS) {
    return null;
  }
  let chars = 0;
  for (const text of value) {
    if (typeof text !== "string" || text.length > PAGE_MAX_ITEM_CHARS) {
      return null;
    }
    chars += text.length;
  }
  return chars <= PAGE_MAX_REQUEST_CHARS ? (value as string[]) : null;
}

/**
 * Why the page channel cannot take a request right now, in words the user
 * can act on — or null when it can. A channel that is not set up says so; it
 * never quietly hands the page to another service.
 */
async function pageChannelProblem(settings: TranslationSettings): Promise<string | null> {
  switch (resolvePageEngine(settings)) {
    case "browser":
      return "网页翻译通道是 Chrome 内置本地翻译，它在页面里运行。请刷新页面后重试。";
    case "deepl":
      if (!settings.draftApiKey) {
        return "网页翻译通道选的是 DeepL，但还没有填写 DeepL API Key（设置页「草稿翻译 API Key」）。";
      }
      return draftPermissionProblem(settings);
    case "custom":
      return draftPermissionProblem(settings);
    case "libretranslate":
      if (!settings.localMtEnabled) {
        return "网页翻译通道选的是本机 LibreTranslate，但它没有启用：请在设置里勾选「启用本机 LibreTranslate」。";
      }
      return (await localMtPermissionMissing(settings))
        ? `尚未授权访问本机翻译服务 ${hostOf(settings.localMtUrl)}：请在设置页保存一次并允许。`
        : null;
    case "openai-compatible":
    case "websocket":
      return (await cachedPermissionFailure(settings))?.message ?? null;
    case "mock":
    default:
      return null;
  }
}

async function draftPermissionProblem(settings: TranslationSettings): Promise<string | null> {
  return (await requiredDraftPermissionMissing(settings))
    ? `尚未授权连接 ${hostOf(settings.draftEndpointUrl)}：请在设置页保存「网页翻译通道」，并在 Chrome 询问时允许。`
    : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Opens the side panel for a selection and hands the selection over.
 *
 * The panel is asked to open first and synchronously: Chrome only lets an
 * extension open it in response to a user action, and this runs inside the
 * click (on the page's button, or on the context menu) that asked for it.
 * The text waits in a short-lived inbox, because a panel that is still
 * loading cannot hear the message that follows.
 */
function showSelectionInSidePanel(
  rawText: unknown,
  source: LanguageTag | null,
  tab: chrome.tabs.Tab | undefined
): Promise<{ ok: boolean; error?: string }> {
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (tab?.id === undefined) {
    return Promise.resolve({ ok: false, error: "没有可以打开侧边栏的标签页。" });
  }
  if (!text) {
    return Promise.resolve({ ok: false, error: "没有选中任何文字。" });
  }
  if (text.length > SIDE_PANEL_MAX_CHARS) {
    return Promise.resolve({
      ok: false,
      error: `选中的文字超过 ${SIDE_PANEL_MAX_CHARS} 字，请分段选择后再发送到侧边栏。`
    });
  }
  if (typeof chrome.sidePanel?.open !== "function") {
    return Promise.resolve({ ok: false, error: "这个 Chrome 版本不支持扩展侧边栏（需要 Chrome 116 或更新版本）。" });
  }
  let opening: Promise<void>;
  try {
    opening = chrome.sidePanel.open({ tabId: tab.id });
  } catch (error) {
    return Promise.resolve({ ok: false, error: `无法打开侧边栏：${errorText(error)}` });
  }
  const entry = queueSidePanelEntry({
    text,
    source: source && isLanguageTag(source) ? source : null,
    pageTitle: tab.title ?? "",
    windowId: tab.windowId ?? null
  });
  return opening.then(
    () => {
      deliverToSidePanel(entry);
      return { ok: true };
    },
    (error: unknown) => ({ ok: false, error: `无法打开侧边栏：${errorText(error)}` })
  );
}

function queueSidePanelEntry(input: Omit<SidePanelEntry, "id" | "at">): SidePanelEntry {
  const entry: SidePanelEntry = { ...input, id: crypto.randomUUID(), at: Date.now() };
  sidePanelInbox.push(entry);
  sidePanelInbox.splice(0, Math.max(0, sidePanelInbox.length - SIDE_PANEL_INBOX_LIMIT));
  return entry;
}

/**
 * What a panel missed while it was opening, handed over once: the panel keeps
 * its entries only while it is open, and one opened again later must not
 * replay what an earlier one already showed.
 */
function takeSidePanelEntries(windowId: number | undefined): SidePanelEntry[] {
  const now = Date.now();
  const taken: SidePanelEntry[] = [];
  const kept: SidePanelEntry[] = [];
  for (const entry of sidePanelInbox) {
    if (now - entry.at >= SIDE_PANEL_INBOX_TTL_MS) {
      continue;
    }
    const forThisPanel =
      windowId === undefined || entry.windowId === null || entry.windowId === windowId;
    (forThisPanel ? taken : kept).push(entry);
  }
  sidePanelInbox.splice(0, sidePanelInbox.length, ...kept);
  return taken;
}

/** Sent to whichever panel is open; the one that takes it answers, and it leaves the inbox. */
function deliverToSidePanel(entry: SidePanelEntry): void {
  try {
    const sent = chrome.runtime.sendMessage?.({
      type: "SIDE_PANEL_ENTRY",
      entry
    } satisfies ExtensionMessage) as Promise<unknown> | undefined;
    void sent?.then(
      (reply) => {
        if ((reply as { received?: unknown } | undefined)?.received === true) {
          const index = sidePanelInbox.findIndex((queued) => queued.id === entry.id);
          if (index >= 0) {
            sidePanelInbox.splice(index, 1);
          }
        }
      },
      () => undefined
    );
  } catch {
    // No panel is open yet; it takes the entry from the inbox when it is.
  }
}

/** Extension pages (the side panel, an open popup) hear runtime messages; tabs do not. */
function sendToExtensionPages(message: ExtensionMessage): void {
  try {
    const sent = chrome.runtime.sendMessage?.(message) as Promise<unknown> | undefined;
    void sent?.catch?.(() => undefined);
  } catch {
    // No extension page is open to hear it.
  }
}

function installContextMenus(): void {
  const menus = chrome.contextMenus;
  if (!menus) {
    return;
  }
  const ignoreError = () => void chrome.runtime.lastError;
  menus.removeAll(() => {
    ignoreError();
    menus.create(
      { id: MENU_TRANSLATE_PAGE, title: "翻译整页 / 显示原文", contexts: ["page"] },
      ignoreError
    );
    menus.create(
      { id: MENU_SELECTION_SIDE_PANEL, title: "在侧边栏翻译「%s」", contexts: ["selection"] },
      ignoreError
    );
  });
}

/** The toolbar badge says which tab shows a translated page — in text, not only colour. */
function setPageBadge(tabId: number, state: PageTranslationBadgeState): void {
  const action = chrome.action;
  if (!action?.setBadgeText) {
    return;
  }
  const text = state === "translated" ? "译" : state === "working" ? "…" : state === "error" ? "!" : "";
  void action.setBadgeText({ tabId, text }).catch(() => undefined);
  if (text) {
    void action
      .setBadgeBackgroundColor({ tabId, color: state === "error" ? "#b3261e" : "#4d6b1f" })
      .catch(() => undefined);
  }
}

/**
 * Runs a page command in a tab, putting the content script there first when
 * the command needs one. `activeTab` covers that: the user just clicked the
 * toolbar button, a context menu item or the shortcut for this very tab, so
 * no site-wide permission is needed to translate the page in front of them.
 */
async function runPageCommandInTab(
  command: PageCommand,
  tabId: number
): Promise<PageCommandResponse> {
  if (command === "translate-page" || command === "toggle-page") {
    const problem = await ensureContentScript(tabId);
    if (problem) {
      return { ok: false, error: problem };
    }
  }
  try {
    const result = (await chrome.tabs.sendMessage(tabId, {
      type: "PAGE_COMMAND",
      command
    } satisfies ExtensionMessage)) as PageCommandResponse | undefined;
    if (!result) {
      return { ok: false, error: "页面没有响应，请刷新页面后重试。" };
    }
    return result;
  } catch {
    if (command === "page-state" || command === "restore-page") {
      // No content script means nothing on the page was translated.
      return { ok: true, translated: false };
    }
    return { ok: false, error: "无法与当前页面通信。请刷新页面后重试。" };
  }
}

/** Null once a content script answers in the tab, otherwise why it cannot. */
async function ensureContentScript(tabId: number): Promise<string | null> {
  if (await contentScriptAnswers(tabId)) {
    return null;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/index.js"] });
  } catch {
    return "这个页面不允许扩展运行（例如 Chrome 内部页面、应用商店或 PDF 预览），无法翻译。";
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await contentScriptAnswers(tabId)) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return "页面脚本没有响应，请刷新页面后重试。";
}

async function contentScriptAnswers(tabId: number): Promise<boolean> {
  try {
    const answer = (await chrome.tabs.sendMessage(tabId, {
      type: "PING"
    } satisfies ExtensionMessage)) as { ok?: unknown } | undefined;
    return answer?.ok === true;
  } catch {
    return false;
  }
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
  command: PageCommand,
  tabId?: number
): Promise<PageCommandResponse> {
  if (command === "enable-meeting-hosts") {
    // Only the meeting origins, never the all-sites grant: the user is
    // authorizing one meeting platform and should see exactly that domain.
    // The grant itself is requested by the options page, which has the user
    // gesture; this only registers the script once the origin is really ours.
    const origins = [...MEETING_HOST_PERMISSIONS];
    if (!(await chrome.permissions.contains({ origins }))) {
      return { ok: false, error: "未获得访问 meet.google.com 的授权。" };
    }
    const registered = await registeredContentScriptIds();
    // The all-pages registration already covers Meet. Registering both would
    // inject the content script twice and put two overlays on the call.
    if (!registered.has(ALL_PAGES_CONTENT_SCRIPT_ID) && !registered.has(MEETING_CONTENT_SCRIPT_ID)) {
      try {
        await chrome.scripting.registerContentScripts([
          {
            id: MEETING_CONTENT_SCRIPT_ID,
            matches: origins,
            js: ["content/index.js"],
            runAt: "document_idle",
            persistAcrossSessions: true
          }
        ]);
      } catch {
        // Already registered from a previous grant.
      }
    }
    return { ok: true, message: "Google Meet 会议字幕已启用，请刷新会议页面。" };
  }

  if (command === "ensure-hosts") {
    // Granted by the popup, from the user's click; this only registers.
    if (!(await chrome.permissions.contains({ origins: ALL_SITES_ORIGINS }))) {
      return { ok: false, error: "未获得访问所有网站的授权。" };
    }
    await registerAllPagesScript();
    return { ok: true, message: "已在所有网站启用划词翻译，刷新已打开的网页后生效。" };
  }

  if (tabId === undefined) {
    return { ok: false, error: "没有活动标签页。" };
  }
  return runPageCommandInTab(command, tabId);
}

/** Puts the content script on every site once the all-sites grant exists. */
async function registerAllPagesScript(): Promise<void> {
  if (!(await chrome.permissions.contains({ origins: ALL_SITES_ORIGINS }))) {
    return;
  }
  const registered = await registeredContentScriptIds();
  if (registered.has(MEETING_CONTENT_SCRIPT_ID)) {
    // Subsumed by the all-pages registration below; leaving it would inject
    // the content script twice on Meet.
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [MEETING_CONTENT_SCRIPT_ID] });
    } catch {
      // Nothing registered under that id after all.
    }
  }
  if (!registered.has(ALL_PAGES_CONTENT_SCRIPT_ID)) {
    try {
      await chrome.scripting.registerContentScripts([
        {
          id: ALL_PAGES_CONTENT_SCRIPT_ID,
          matches: ALL_SITES_ORIGINS,
          js: ["content/index.js"],
          runAt: "document_idle",
          persistAcrossSessions: true
        }
      ]);
    } catch {
      // Already registered from a previous grant.
    }
  }
}

async function registeredContentScriptIds(): Promise<Set<string>> {
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    return new Set(scripts.map((script) => script.id));
  } catch {
    return new Set();
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
        text: sampleSourceText(settings.sourceLanguage),
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

/** Meeting lines arrive faster than a storage round-trip; serialize the folds. */
function queueTranscriptStorageUpdate(update: () => Promise<void>): Promise<void> {
  const operation = transcriptStorageQueue.then(update, update);
  transcriptStorageQueue = operation.catch(() => undefined);
  return operation;
}

/**
 * D7: transcripts expire even if the user never opens another meeting, so the
 * retention window is also enforced when the worker wakes up.
 */
async function pruneStoredTranscripts(): Promise<void> {
  const settings = await getSettings();
  await queueTranscriptStorageUpdate(async () => {
    const stored = await chrome.storage.local.get(MEETING_TRANSCRIPT_PRUNED_AT_KEY);
    if (!transcriptPruneDue(stored[MEETING_TRANSCRIPT_PRUNED_AT_KEY], Date.now())) {
      return;
    }
    await dropExpiredTranscripts(settings.meetingTranscriptRetentionDays);
    await chrome.storage.local.set({ [MEETING_TRANSCRIPT_PRUNED_AT_KEY]: Date.now() });
  });
}

/** Makes the next wake sweep whatever the last one left behind. */
async function forgetTranscriptPruneMarker(): Promise<void> {
  await queueTranscriptStorageUpdate(async () => {
    await chrome.storage.local.remove(MEETING_TRANSCRIPT_PRUNED_AT_KEY);
  });
}

/** Runs inside the transcript queue; never queue it again from within. */
async function dropExpiredTranscripts(retentionDays: number): Promise<void> {
  const stored = await chrome.storage.local.get(null);
  const expired = expiredTranscriptKeys(
    readTranscriptSessions(stored),
    Date.now(),
    retentionDays
  );
  if (expired.length > 0) {
    await chrome.storage.local.remove(expired);
  }
  const failures = readTranscriptFailures(stored[MEETING_TRANSCRIPT_FAILURE_KEY]);
  const kept = retainedTranscriptFailures(failures, Date.now(), retentionDays);
  if (Object.keys(kept).length === Object.keys(failures).length) {
    return;
  }
  // A note about a meeting goes when that meeting's record goes: the same
  // window, so it never outlives what it describes and never leaves first.
  if (Object.keys(kept).length === 0) {
    await chrome.storage.local.remove(MEETING_TRANSCRIPT_FAILURE_KEY);
    return;
  }
  await chrome.storage.local.set({ [MEETING_TRANSCRIPT_FAILURE_KEY]: kept });
}

async function clearStoredTranscripts(): Promise<void> {
  await queueTranscriptStorageUpdate(async () => {
    const keys = Object.keys(await chrome.storage.local.get(null)).filter(isTranscriptSessionKey);
    if (keys.length > 0) {
      await chrome.storage.local.remove(keys);
    }
    await chrome.storage.local.remove(MEETING_TRANSCRIPT_PRUNED_AT_KEY);
  });
  await forgetTranscriptFailures();
  await forgetMeetingRecords();
}

/**
 * Consent withdrawn: nothing said in a call is remembered anywhere any more,
 * including the snapshot that carries it across a worker sleep, and including
 * the names of who said it. A call still running forgets as much as one
 * already over.
 *
 * Only calls. An episode being translated in another tab keeps its context
 * and its caches: it was never the thing consent was given for.
 */
async function forgetMeetingRecords(): Promise<void> {
  sessionStore.forgetMeetingSessions();
  await queueContextStorageUpdate(async () => {
    const stored = await chrome.storage.session.get(SESSION_CONTEXT_STORAGE_KEY);
    const sessions = readPersistedSessions(stored[SESSION_CONTEXT_STORAGE_KEY]);
    const kept = Object.fromEntries(
      Object.entries(sessions).filter(([, session]) => session.meeting !== true)
    );
    if (Object.keys(kept).length === Object.keys(sessions).length) {
      return;
    }
    await chrome.storage.session.set({ [SESSION_CONTEXT_STORAGE_KEY]: kept });
  });
}

/**
 * The profile's storage is shared and finite, and a transcript is the one
 * thing here that grows without bound. A refused write is the user's
 * business: translation keeps running, but the meeting is no longer being
 * recorded, and saying so once in the popup's live status is not saying it —
 * the next caption overwrites that line a second later. The failure is
 * therefore kept until the records are cleared, so the settings page can
 * still tell the user afterwards that the call stopped being recorded.
 */
async function reportTranscriptStorageFailure(
  sessionId: string,
  tabId: number | undefined,
  error: unknown
): Promise<void> {
  if (transcriptStorageFailures.has(sessionId)) {
    return;
  }
  transcriptStorageFailures.add(sessionId);
  const reason = errorText(error);
  await rememberTranscriptFailure(sessionId, reason);
  if (tabId === undefined) {
    return;
  }
  await setTabStatus(tabId, {
    state: "error",
    message: `会议记录未能写入本机存储（${reason}）：翻译继续，但这场会议不再被记录。可在设置页清除会议记录后重试。`,
    source: "meet-dom",
    updatedAt: Date.now()
  });
}

/**
 * Kept beside the transcripts in `chrome.storage.local`, not in the session
 * area: the truncated record lives for the whole retention window, and a note
 * about it that disappeared when the browser closed would leave the user with
 * a half-recorded meeting and no way to find out.
 */
async function rememberTranscriptFailure(sessionId: string, reason: string): Promise<void> {
  try {
    const failures = await storedTranscriptFailures();
    failures[sessionId] = { reason, atMs: Date.now() };
    await chrome.storage.local.set({ [MEETING_TRANSCRIPT_FAILURE_KEY]: failures });
  } catch {
    // The same full storage that refused the line can refuse this note; the
    // popup still says so for this meeting, and captions carry on.
  }
}

async function storedTranscriptFailures(): Promise<Record<string, TranscriptFailure>> {
  const stored = await chrome.storage.local.get(MEETING_TRANSCRIPT_FAILURE_KEY);
  return readTranscriptFailures(stored[MEETING_TRANSCRIPT_FAILURE_KEY]);
}

async function forgetTranscriptFailures(): Promise<void> {
  transcriptStorageFailures.clear();
  await chrome.storage.local.remove(MEETING_TRANSCRIPT_FAILURE_KEY);
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.trim() || "存储空间可能已满";
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
  // The side panel follows the target language and channel as they change.
  sendToExtensionPages(message);
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.flatMap((tab) =>
      tab.id === undefined
        ? []
        : [chrome.tabs.sendMessage(tab.id, message).catch(() => undefined)]
    )
  );
}
