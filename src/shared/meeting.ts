import type { MeetingFinalChannel, SubtitleSource, TranslationSettings } from "./types";

/**
 * Meeting mode: the same caption pipeline pointed at a meeting page's own
 * captions. It reads only text the meeting site already renders into the DOM —
 * no audio capture, no ASR, no meeting SDK, no recording of the call itself.
 */

/** M1 ships one platform. Every other meeting host is out of scope. */
export const MEETING_HOSTS = ["meet.google.com"] as const;

/**
 * Meet is an optional host: nothing is read from a meeting until the user
 * grants this origin from the options page and sees the domain while doing it.
 */
export const MEETING_HOST_PERMISSIONS = ["https://meet.google.com/*"] as const;

export const MEETING_CONTENT_SCRIPT_ID = "tranlithion-meeting-hosts";

/**
 * How long a meeting channel may take to answer one line.
 *
 * When a channel *is* the caption there is nothing slower waiting behind it,
 * so it is worth more than a draft's budget — but meeting jobs run one at a
 * time, so an answer that never comes has to cost this line rather than every
 * line after it. One rule for all three channels, stated once.
 */
export const MEETING_FINAL_CHANNEL_TIMEOUT_MS = 4_000;

export function isMeetingHost(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase();
  return MEETING_HOSTS.some((host) => normalized === host);
}

/**
 * Whether what was said in this cue may be kept in memory that reaches
 * storage — the session context the model reads back, and the snapshot of it
 * the worker restores after a sleep.
 *
 * A user who left the meeting transcript switched off declined a record of
 * the call, and that answer holds for every channel: the terms the call
 * teaches us still accumulate for its duration, the sentences and the names
 * that said them are never written down.
 */
export function keepsSpokenRecord(
  settings: Pick<TranslationSettings, "meetingTranscript">,
  source: SubtitleSource
): boolean {
  return source !== "meet-dom" || settings.meetingTranscript;
}

/**
 * Meeting behaviour never leaks onto ordinary pages: it needs both the user's
 * meeting-mode switch and an actual meeting host.
 */
export function isMeetingModeActive(
  settings: Pick<TranslationSettings, "meetingMode">,
  hostname: string
): boolean {
  return settings.meetingMode && isMeetingHost(hostname);
}

/**
 * D7 disclosure: which service the meeting's spoken text is sent to. This is
 * shown in the options page next to the transcript controls, because "who
 * hears my meeting" is not something a user should have to infer from the
 * translation-service section.
 */
export function meetingTextDestination(
  settings: Pick<
    TranslationSettings,
    | "meetingFinalChannel"
    | "draftProvider"
    | "draftEndpointUrl"
    | "localMtUrl"
    | "provider"
    | "apiBaseUrl"
    | "webSocketUrl"
    | "model"
  >
): string {
  switch (settings.meetingFinalChannel) {
    case "local-mt":
      return `本机 LibreTranslate（${hostOf(settings.localMtUrl)}），字幕文本不离开这台电脑。`;
    case "llm":
      return `大模型翻译服务 ${describeMainProvider(settings)}，会议字幕文本会发送到该服务。`;
    case "fast-mt":
    default:
      if (settings.draftProvider === "browser") {
        return "Chrome 内置本地翻译模型，字幕文本不离开这台电脑。";
      }
      return `${
        settings.draftProvider === "deepl" ? "DeepL" : "自定义机器翻译服务"
      }（${hostOf(settings.draftEndpointUrl)}），会议字幕文本会发送到该服务。`;
  }
}

/** Short label for the channel that produces the caption the user reads. */
export function meetingFinalChannelLabel(channel: MeetingFinalChannel): string {
  switch (channel) {
    case "local-mt":
      return "本机 LibreTranslate";
    case "llm":
      return "大模型主译";
    case "fast-mt":
    default:
      return "机器翻译通道";
  }
}

function describeMainProvider(
  settings: Pick<TranslationSettings, "provider" | "apiBaseUrl" | "webSocketUrl" | "model">
): string {
  if (settings.provider === "mock") {
    return "（演示模式，不联网）";
  }
  if (settings.provider === "websocket") {
    return hostOf(settings.webSocketUrl);
  }
  return `${hostOf(settings.apiBaseUrl)} 的 ${settings.model}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
