import { normalizeLanguagePair, normalizeLanguageTag } from "./language";
import type {
  CaptionPosition,
  DraftProvider,
  GlossaryEntry,
  MeetingFinalChannel,
  PageTranslateChannel,
  PublicTranslationSettings,
  TranslationSettings,
  TranslatorProvider
} from "./types";

export const SETTINGS_STORAGE_KEY = "translation-settings";

/** D7: a meeting transcript is deleted automatically after this many days. */
export const DEFAULT_TRANSCRIPT_RETENTION_DAYS = 7;
export const MIN_TRANSCRIPT_RETENTION_DAYS = 1;
export const MAX_TRANSCRIPT_RETENTION_DAYS = 90;

export const DEFAULT_SETTINGS: TranslationSettings = {
  enabled: true,
  provider: "openai-compatible",
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4.1-mini",
  webSocketUrl: "ws://localhost:8787",
  sourceLanguage: "ja",
  targetLanguage: "zh-CN",
  showOriginal: false,
  fontSizePx: 28,
  position: "bottom",
  backgroundOpacity: 0.76,
  glossary: [],
  draftCaptions: true,
  draftProvider: "browser",
  draftEndpointUrl: "https://api-free.deepl.com/v2/translate",
  draftApiKey: "",
  localMtEnabled: true,
  localMtUrl: "http://127.0.0.1:5000/translate",
  // Page text can be anything the user reads — mail, internal documents — so
  // the default channel keeps it on the device. Sending pages to a cloud
  // service is a choice the user makes in settings, where its host is named.
  pageTranslateChannel: "browser",
  selectionToolbar: true,
  // Meeting mode is opt-in: reading what people say in a call, and keeping it
  // on disk, starts when the user asks for it in settings — never because an
  // earlier all-sites permission happens to cover meet.google.com.
  meetingMode: false,
  meetingFinalChannel: "fast-mt",
  meetingSelectionToolbar: false,
  meetingOverlayHidden: false,
  meetingTranscript: false,
  meetingTranscriptRetentionDays: DEFAULT_TRANSCRIPT_RETENTION_DAYS
};

const PROVIDERS = new Set<TranslatorProvider>([
  "openai-compatible",
  "websocket",
  "mock"
]);
const POSITIONS = new Set<CaptionPosition>(["top", "middle", "bottom"]);
const DRAFT_PROVIDERS = new Set<DraftProvider>(["browser", "deepl", "custom"]);
const MEETING_FINAL_CHANNELS = new Set<MeetingFinalChannel>([
  "fast-mt",
  "local-mt",
  "llm"
]);
const PAGE_TRANSLATE_CHANNELS = new Set<PageTranslateChannel>([
  "browser",
  "local-mt",
  "fast-mt",
  "llm"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string, maxLength = 1_000): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : fallback;
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function normalizeUrl(value: unknown, fallback: string, protocols: string[]): string {
  const candidate = stringValue(value, fallback, 2_000);
  try {
    const url = new URL(candidate);
    if (!protocols.includes(url.protocol)) {
      return fallback;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

export function normalizeGlossary(value: unknown): GlossaryEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const entries: GlossaryEntry[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue;
    }
    const source = stringValue(entry.source, "", 120);
    const target = stringValue(entry.target, "", 120);
    const kind = entry.kind === "name" ? "name" : "term";
    const key = source.toLocaleLowerCase();
    if (!source || !target || seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push({ source, target, kind });
    if (entries.length >= 100) {
      break;
    }
  }
  return entries;
}

export function parseGlossary(input: string): GlossaryEntry[] {
  const entries = input.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(.+?)\s*(?:=>|→|=|：|:)\s*(.+?)\s*$/);
    if (!match) {
      return [];
    }
    const source = match[1].trim();
    const target = match[2].trim();
    const kind = source.startsWith("@");
    return [{
      source: kind ? source.slice(1).trim() : source,
      target,
      kind: kind ? "name" : "term"
    } satisfies GlossaryEntry];
  });
  return normalizeGlossary(entries);
}

export function formatGlossary(glossary: GlossaryEntry[]): string {
  return glossary
    .map((entry) => `${entry.kind === "name" ? "@" : ""}${entry.source} = ${entry.target}`)
    .join("\n");
}

export function normalizeSettings(value: unknown): TranslationSettings {
  const record = isRecord(value) ? value : {};
  const provider = PROVIDERS.has(record.provider as TranslatorProvider)
    ? (record.provider as TranslatorProvider)
    : DEFAULT_SETTINGS.provider;
  const position = POSITIONS.has(record.position as CaptionPosition)
    ? (record.position as CaptionPosition)
    : DEFAULT_SETTINGS.position;
  // Source and target come from two independent selects, so the pair is
  // normalized together: a target equal to the source is not translatable.
  const { source: sourceLanguage, target: targetLanguage } = normalizeLanguagePair(
    normalizeLanguageTag(record.sourceLanguage, DEFAULT_SETTINGS.sourceLanguage),
    normalizeLanguageTag(record.targetLanguage, DEFAULT_SETTINGS.targetLanguage)
  );

  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : DEFAULT_SETTINGS.enabled,
    provider,
    apiBaseUrl: normalizeUrl(record.apiBaseUrl, DEFAULT_SETTINGS.apiBaseUrl, ["https:", "http:"]),
    apiKey: stringValue(record.apiKey, "", 2_000),
    model: stringValue(record.model, DEFAULT_SETTINGS.model, 160),
    webSocketUrl: normalizeUrl(record.webSocketUrl, DEFAULT_SETTINGS.webSocketUrl, ["wss:", "ws:"]),
    sourceLanguage,
    targetLanguage,
    showOriginal:
      typeof record.showOriginal === "boolean"
        ? record.showOriginal
        : DEFAULT_SETTINGS.showOriginal,
    fontSizePx: clamp(record.fontSizePx, DEFAULT_SETTINGS.fontSizePx, 16, 48),
    position,
    backgroundOpacity: clamp(
      record.backgroundOpacity,
      DEFAULT_SETTINGS.backgroundOpacity,
      0.35,
      1
    ),
    glossary: normalizeGlossary(record.glossary),
    draftCaptions:
      typeof record.draftCaptions === "boolean"
        ? record.draftCaptions
        : DEFAULT_SETTINGS.draftCaptions,
    draftProvider: DRAFT_PROVIDERS.has(record.draftProvider as DraftProvider)
      ? (record.draftProvider as DraftProvider)
      : DEFAULT_SETTINGS.draftProvider,
    draftEndpointUrl: normalizeUrl(
      record.draftEndpointUrl,
      DEFAULT_SETTINGS.draftEndpointUrl,
      ["https:", "http:"]
    ),
    draftApiKey: stringValue(record.draftApiKey, "", 2_000),
    localMtEnabled:
      typeof record.localMtEnabled === "boolean"
        ? record.localMtEnabled
        : DEFAULT_SETTINGS.localMtEnabled,
    localMtUrl: normalizeUrl(
      record.localMtUrl,
      DEFAULT_SETTINGS.localMtUrl,
      ["https:", "http:"]
    ),
    pageTranslateChannel: PAGE_TRANSLATE_CHANNELS.has(
      record.pageTranslateChannel as PageTranslateChannel
    )
      ? (record.pageTranslateChannel as PageTranslateChannel)
      : DEFAULT_SETTINGS.pageTranslateChannel,
    selectionToolbar:
      typeof record.selectionToolbar === "boolean"
        ? record.selectionToolbar
        : DEFAULT_SETTINGS.selectionToolbar,
    meetingMode:
      typeof record.meetingMode === "boolean"
        ? record.meetingMode
        : DEFAULT_SETTINGS.meetingMode,
    meetingFinalChannel: MEETING_FINAL_CHANNELS.has(
      record.meetingFinalChannel as MeetingFinalChannel
    )
      ? (record.meetingFinalChannel as MeetingFinalChannel)
      : DEFAULT_SETTINGS.meetingFinalChannel,
    // Before the selection buttons replaced the mascot this was
    // `meetingMascot`; a user who allowed the mascot in meetings keeps that.
    meetingSelectionToolbar:
      typeof record.meetingSelectionToolbar === "boolean"
        ? record.meetingSelectionToolbar
        : typeof record.meetingMascot === "boolean"
          ? record.meetingMascot
          : DEFAULT_SETTINGS.meetingSelectionToolbar,
    meetingOverlayHidden:
      typeof record.meetingOverlayHidden === "boolean"
        ? record.meetingOverlayHidden
        : DEFAULT_SETTINGS.meetingOverlayHidden,
    meetingTranscript:
      typeof record.meetingTranscript === "boolean"
        ? record.meetingTranscript
        : DEFAULT_SETTINGS.meetingTranscript,
    meetingTranscriptRetentionDays: Math.round(
      clamp(
        record.meetingTranscriptRetentionDays,
        DEFAULT_SETTINGS.meetingTranscriptRetentionDays,
        MIN_TRANSCRIPT_RETENTION_DAYS,
        MAX_TRANSCRIPT_RETENTION_DAYS
      )
    )
  };
}

export function publicSettings(settings: TranslationSettings): PublicTranslationSettings {
  // Both keys are stripped here: content scripts share a page with the video
  // site, so they only ever learn whether a key exists, never its value.
  const { apiKey, draftApiKey, ...safeSettings } = settings;
  return {
    ...safeSettings,
    apiKeyConfigured: apiKey.length > 0,
    draftApiKeyConfigured: draftApiKey.length > 0
  };
}

export function mergeSettings(
  current: TranslationSettings,
  patch: Partial<TranslationSettings>
): TranslationSettings {
  return normalizeSettings({ ...current, ...patch });
}
