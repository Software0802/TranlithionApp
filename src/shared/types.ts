export type SourceLanguage = "ja" | "en";
export type TargetLanguage = "zh-CN";
export type SubtitleSource = "text-track" | "youtube-dom" | "netflix-dom";
export type TranslatorProvider = "openai-compatible" | "websocket" | "mock";

/**
 * Which service produces the immediate draft caption. `browser` runs Chrome's
 * on-device model inside the content script; the remote options run in the
 * background worker because they need a key the page must never see.
 */
export type DraftProvider = "browser" | "deepl" | "custom";

/**
 * How complete the caption currently on screen is. Ranks are monotonic: a
 * late-arriving draft must never overwrite streamed or final text.
 */
export type CaptionStage = "none" | "draft" | "streaming" | "final";

export const CAPTION_STAGE_RANK: Record<CaptionStage, number> = {
  none: 0,
  draft: 1,
  streaming: 2,
  final: 3
};

/**
 * Whether `next` may overwrite what is already on screen. The local draft and
 * the translation service race each other, so a draft that resolves late must
 * not pull a finished caption back to lower-quality text.
 */
export function shouldReplaceCaption(current: CaptionStage, next: CaptionStage): boolean {
  return CAPTION_STAGE_RANK[next] > CAPTION_STAGE_RANK[current];
}
export type CaptionPosition = "top" | "middle" | "bottom";
export type TabTranslationState =
  | "idle"
  | "searching"
  | "ready"
  | "translating"
  | "unavailable"
  | "error";

export interface SubtitleCue {
  id: string;
  startMs: number;
  endMs: number | null;
  text: string;
  isFinal: boolean;
  source: SubtitleSource;
}

export interface GlossaryEntry {
  source: string;
  target: string;
  kind: "term" | "name";
}

export interface EntityHint extends GlossaryEntry {}

export interface TranslationResult {
  text: string;
  provider: TranslatorProvider;
  latencyMs: number;
  entityHints: EntityHint[];
}

export interface TranslationFailure {
  code:
    | "NOT_CONFIGURED"
    | "NETWORK"
    | "TIMEOUT"
    | "PROVIDER"
    | "INVALID_RESPONSE"
    | "PERMISSION"
    | "CANCELLED"
    | "UNKNOWN";
  message: string;
}

export interface TranslationSettings {
  enabled: boolean;
  provider: TranslatorProvider;
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  webSocketUrl: string;
  sourceLanguage: SourceLanguage;
  targetLanguage: TargetLanguage;
  showOriginal: boolean;
  fontSizePx: number;
  position: CaptionPosition;
  backgroundOpacity: number;
  glossary: GlossaryEntry[];
  /**
   * Show Chrome's on-device translation immediately while the configured
   * service is still answering. Silently ignored when the browser cannot
   * translate the configured language pair locally.
   */
  draftCaptions: boolean;
  draftProvider: DraftProvider;
  /** Translation endpoint for `deepl` and `custom` draft providers. */
  draftEndpointUrl: string;
  draftApiKey: string;
  /**
   * Local LibreTranslate (or compatible) for full-page / selection translation.
   * Video captions keep using DeepL / the main provider.
   */
  localMtEnabled: boolean;
  localMtUrl: string;
}

export interface PublicTranslationSettings
  extends Omit<TranslationSettings, "apiKey" | "draftApiKey"> {
  apiKeyConfigured: boolean;
  draftApiKeyConfigured: boolean;
}

export interface ContextLine {
  cueId: string;
  source: string;
  translation: string;
  atMs: number;
}

export interface RuntimeStatus {
  state: TabTranslationState;
  message: string;
  source?: SubtitleSource;
  /** Full provider response time; streamed text may appear earlier. */
  latencyMs?: number;
  updatedAt: number;
}

export interface TabRuntimeStatus extends RuntimeStatus {
  tabId: number;
}

export interface TranslationRequest {
  sessionId: string;
  cue: SubtitleCue;
}

export interface TranslationResponse {
  ok: boolean;
  translation?: TranslationResult;
  error?: TranslationFailure;
}
