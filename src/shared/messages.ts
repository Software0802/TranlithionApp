import type {
  PublicTranslationSettings,
  RuntimeStatus,
  TabRuntimeStatus,
  TranslationRequest,
  TranslationResponse,
  TranslationSettings
} from "./types";

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
  | { type: "DRAFT_TRANSLATE"; sessionId: string; cueId: string; text: string }
  | { type: "TRANSLATE_PLAIN"; text: string }
  | { type: "TRANSLATE_PLAIN_BATCH"; texts: string[] }
  | { type: "PAGE_COMMAND"; command: "translate-page" | "restore-page" | "ensure-hosts" };

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
