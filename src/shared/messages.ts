import type {
  PublicTranslationSettings,
  RuntimeStatus,
  SubtitleCue,
  TabRuntimeStatus,
  TranslationRequest,
  TranslationResponse,
  TranslationSettings
} from "./types";

export type PageCommand =
  | "translate-page"
  | "restore-page"
  | "ensure-hosts"
  /** Grants only the meeting hosts and registers their content script. */
  | "enable-meeting-hosts";

export type ExtensionMessage =
  | { type: "GET_PUBLIC_SETTINGS" }
  | { type: "GET_OPTIONS_SETTINGS" }
  | { type: "SAVE_SETTINGS"; patch: Partial<TranslationSettings> }
  | { type: "GET_TAB_STATUS"; tabId: number }
  | { type: "REPORT_TAB_STATUS"; status: RuntimeStatus }
  | { type: "TRANSLATE_CUE"; request: TranslationRequest }
  | { type: "CLEAR_TRANSLATION_SESSION"; sessionId: string }
  | { type: "TEST_TRANSLATION"; settings: TranslationSettings }
  | { type: "SETTINGS_UPDATED"; settings: PublicTranslationSettings }
  | { type: "TRANSLATION_PARTIAL"; sessionId: string; cueId: string; text: string }
  | {
      type: "DRAFT_TRANSLATE";
      sessionId: string;
      cueId: string;
      text: string;
      /** Meeting mode: this channel is the caption, not an optional preview. */
      asFinal?: boolean;
    }
  | { type: "TRANSLATE_PLAIN"; text: string }
  | { type: "TRANSLATE_PLAIN_BATCH"; texts: string[] }
  /**
   * A settled bilingual meeting line. The background worker owns both the
   * retention-limited transcript and the session's term memory, so the
   * content script reports the line instead of storing anything itself.
   */
  | {
      type: "RECORD_MEETING_LINE";
      sessionId: string;
      host: string;
      title: string;
      cue: SubtitleCue;
      translation: string;
    }
  | { type: "GET_MEETING_TRANSCRIPTS" }
  | { type: "CLEAR_MEETING_TRANSCRIPTS" }
  | { type: "PAGE_COMMAND"; command: PageCommand };

export interface MeetingTranscriptSummary {
  sessions: number;
  lines: number;
  /** Epoch ms of the newest recorded line, or null when nothing is stored. */
  updatedAtMs: number | null;
  retentionDays: number;
}

export interface MeetingTranscriptResponse {
  ok: boolean;
  summary?: MeetingTranscriptSummary;
}

export interface DraftTranslationResponse {
  ok: boolean;
  text?: string;
}

export interface PlainTranslationResponse {
  ok: boolean;
  text?: string;
  error?: string;
}

export interface PlainBatchTranslationResponse {
  ok: boolean;
  texts?: string[];
  error?: string;
}

export interface SaveSettingsResponse {
  ok: boolean;
  settings?: TranslationSettings;
  error?: string;
}

export interface TabStatusResponse {
  status: TabRuntimeStatus | null;
}

export interface SettingsResponse {
  settings: TranslationSettings | PublicTranslationSettings;
}

export interface TestTranslationResponse extends TranslationResponse {}

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
