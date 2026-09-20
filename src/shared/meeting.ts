import { termKey } from "./terminology";
import type {
  EntityHint,
  GlossaryEntry,
  MeetingFinalChannel,
  SubtitleSource,
  TranslationSettings
} from "./types";

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
 * line after it. One rule for all three machine-translation channels.
 */
export const MEETING_FINAL_CHANNEL_TIMEOUT_MS = 4_000;

/**
 * The chat model reads context and writes a whole sentence, so holding it to a
 * machine-translation hop's budget would drop lines it was about to answer.
 * It still gets a budget: the queue is shared with everything said next.
 */
export const MEETING_LLM_CHANNEL_TIMEOUT_MS = 8_000;

/** How long the configured channel may take before a meeting line is dropped. */
export function meetingLineBudgetMs(channel: MeetingFinalChannel): number {
  return channel === "llm" ? MEETING_LLM_CHANNEL_TIMEOUT_MS : MEETING_FINAL_CHANNEL_TIMEOUT_MS;
}

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
 * The speaker names this call should keep rendering the same way.
 *
 * A display name is registered as itself so the model does not invent a new
 * spelling of it halfway through the meeting — but only when the user has not
 * already said how that name reads. Their glossary is the authority, and a
 * name they pinned needs no help staying stable.
 */
export function speakerEntityHints(
  speaker: string | undefined,
  glossary: GlossaryEntry[]
): EntityHint[] {
  const name = speaker?.trim() ?? "";
  if (!name || glossary.some((entry) => termKey(entry.source) === termKey(name))) {
    return [];
  }
  return [{ source: name, target: name, kind: "name" }];
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
    | "draftCaptions"
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
      // Only a loopback address is this computer. The same setting happily
      // takes a LAN box or a VPS, and saying the text stays here would be a
      // privacy promise the address itself contradicts.
      return isLoopbackUrl(settings.localMtUrl)
        ? `本机 LibreTranslate（${hostOf(settings.localMtUrl)}），字幕文本不离开这台电脑。`
        : `LibreTranslate（${hostOf(
            settings.localMtUrl
          )}），该地址不在这台电脑上，会议字幕文本会发送到那台服务器。`;
    case "llm": {
      const model = `大模型翻译服务 ${describeMainProvider(settings)}，会议字幕文本会发送到该服务。`;
      if (!settings.draftCaptions || settings.draftProvider === "browser") {
        return model;
      }
      // On this channel the draft runs alongside the model, so the same
      // sentence reaches a second service. Naming only one of the two would
      // tell the user their meeting goes somewhere it does not stop.
      return `${model}草稿字幕会把同一句同时发送到 ${draftServiceName(settings)}（${hostOf(
        settings.draftEndpointUrl
      )}）。`;
    }
    case "fast-mt":
    default:
      if (settings.draftProvider === "browser") {
        return "Chrome 内置本地翻译模型，字幕文本不离开这台电脑。";
      }
      return `${draftServiceName(settings)}（${hostOf(
        settings.draftEndpointUrl
      )}），会议字幕文本会发送到该服务。`;
  }
}

function draftServiceName(settings: Pick<TranslationSettings, "draftProvider">): string {
  return settings.draftProvider === "deepl" ? "DeepL" : "自定义机器翻译服务";
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

/** Whether this address is served by the user's own machine. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "").toLocaleLowerCase();
    return hostname === "localhost" || hostname === "::1" || /^127\./.test(hostname);
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
