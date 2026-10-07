import type { LanguageTag } from "./language";
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
  /** Translates the page, or puts the original back if it is translated. */
  | "toggle-page"
  /** Reports whether the page is translated without changing anything. */
  | "page-state"
  | "ensure-hosts"
  /** Grants only the meeting hosts and registers their content script. */
  | "enable-meeting-hosts";

/** What the toolbar badge says about a tab's page translation. */
export type PageTranslationBadgeState = "idle" | "working" | "translated" | "error";

export type ExtensionMessage =
  | { type: "GET_PUBLIC_SETTINGS" }
  | { type: "GET_OPTIONS_SETTINGS" }
  | { type: "SAVE_SETTINGS"; patch: Partial<TranslationSettings> }
  | { type: "GET_TAB_STATUS"; tabId: number }
  | { type: "REPORT_TAB_STATUS"; status: RuntimeStatus }
  | { type: "TRANSLATE_CUE"; request: TranslationRequest }
  /**
   * The next lines of a text track, translated ahead of playback so each is
   * already in the session's cache when it comes on screen.
   */
  | { type: "PREFETCH_CUES"; sessionId: string; cues: SubtitleCue[] }
  /**
   * Captions appeared on a page: open the connections its lines will use now.
   * `model` is the main translation service, `draft` the remote draft or
   * machine-translation endpoint; neither request carries a key or any text.
   */
  | { type: "WARM_UP_TRANSLATOR"; model: boolean; draft: boolean }
  | { type: "CLEAR_TRANSLATION_SESSION"; sessionId: string }
  | { type: "TEST_TRANSLATION"; settings: TranslationSettings }
  | { type: "SETTINGS_UPDATED"; settings: PublicTranslationSettings }
  | { type: "TRANSLATION_PARTIAL"; sessionId: string; cueId: string; text: string }
  | {
      type: "DRAFT_TRANSLATE";
      sessionId: string;
      cueId: string;
      text: string;
      /**
       * This channel is the caption, not an optional preview: a meeting's
       * channel, or DeepL alone on Netflix.
       */
      asFinal?: boolean;
      /** The line was said in a call; only these sessions count as meetings. */
      meeting?: boolean;
    }
  /** `sessionId` marks a caption channel, whose session memory answers repeats. */
  | { type: "TRANSLATE_PLAIN"; text: string; sessionId?: string }
  /**
   * Page or selection text for the configured page translation channel.
   * `source` is the language the content script detected; the target is the
   * configured one. `markup` strings carry `<t0>…</t0>` placeholder tags.
   */
  | { type: "TRANSLATE_TEXTS"; texts: string[]; source: LanguageTag; markup?: boolean }
  /**
   * The user chose to read a selection in the side panel. Sent from inside
   * their click: the worker opens the panel before it awaits anything, while
   * the click still counts as a user gesture.
   */
  | { type: "SHOW_IN_SIDE_PANEL"; text: string; source?: LanguageTag | null }
  /**
   * The side panel of `windowId` takes the selections sent while it was still
   * opening. Each is handed over once: taking it removes it.
   */
  | { type: "GET_SIDE_PANEL_INBOX"; windowId?: number }
  /** Worker → side panel: a selection to translate. The panel that takes it answers `{ received: true }`. */
  | { type: "SIDE_PANEL_ENTRY"; entry: SidePanelEntry }
  /** Content script → worker: drives the toolbar badge for this tab. */
  | { type: "PAGE_TRANSLATION_STATE"; state: PageTranslationBadgeState }
  /** Worker → content script: is a content script listening in this tab? */
  | { type: "PING" }
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
  /**
   * `tabId` names the tab when the sender is not one — the popup acts on the
   * active tab but is not itself a tab.
   */
  | { type: "PAGE_COMMAND"; command: PageCommand; tabId?: number };

export interface MeetingTranscriptSummary {
  sessions: number;
  lines: number;
  retentionDays: number;
  /**
   * Meetings whose recording stopped because the browser refused a write.
   * The live status line says so once and is gone with the next caption, so
   * this is how the user can still find out afterwards.
   */
  stopped: { meetings: number; reason: string } | null;
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

export interface TextsTranslationResponse {
  ok: boolean;
  /** One per requested string, in order; null for a string that failed. */
  texts?: Array<string | null>;
  error?: string;
  /** The request failed but a later one may not (a timeout, a rate limit). */
  retryable?: boolean;
}

/** A selection waiting to be translated in the side panel. */
export interface SidePanelEntry {
  id: string;
  text: string;
  /** Detected on the page, where the page's own language can settle it. */
  source: LanguageTag | null;
  /** Title of the tab it came from, shown under the entry. */
  pageTitle: string;
  /** The window whose side panel it is for; each window has its own panel. */
  windowId: number | null;
  at: number;
}

export interface SidePanelInboxResponse {
  entries: SidePanelEntry[];
}

export interface PageCommandResponse {
  ok: boolean;
  message?: string;
  error?: string;
  /** Whether the page shows a translation after the command. */
  translated?: boolean;
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
