/**
 * D7: a local bilingual transcript of a meeting, kept in `chrome.storage.local`
 * and deleted automatically after the retention window.
 *
 * This is deliberately a *store*, not a claim of no persistence: meeting mode
 * writes what was said and what we showed, and the options page says so and
 * offers a one-click wipe. Nothing here leaves the browser profile; the store
 * is written only by the background worker, which already runs behind
 * `TRUSTED_CONTEXTS`, so a content script can never read another tab's meeting.
 *
 * Each meeting lives under its own storage key. A line lands every few seconds
 * for the length of a meeting, and rewriting every meeting ever recorded on
 * each of them would spend megabytes of serialization on one sentence.
 */

import type { MeetingTranscriptSummary } from "./messages";

/** One meeting per key: `meeting-transcript:<sessionId>`. */
export const MEETING_TRANSCRIPT_KEY_PREFIX = "meeting-transcript:";

/** Where the notes about meetings that stopped being recorded are kept. */
export const MEETING_TRANSCRIPT_FAILURE_KEY = "meeting-transcript-failures";

/** Caps so a long day of meetings cannot fill the profile's storage quota. */
export const MAX_TRANSCRIPT_SESSIONS = 20;
export const MAX_TRANSCRIPT_LINES = 2_000;

const DAY_MS = 86_400_000;

export interface MeetingTranscriptLine {
  atMs: number;
  speaker: string | null;
  source: string;
  translation: string;
}

export interface MeetingTranscriptSession {
  sessionId: string;
  /** Meeting host, e.g. `meet.google.com`. */
  host: string;
  /** Page title at the time the first line was recorded. */
  title: string;
  startedAtMs: number;
  updatedAtMs: number;
  lines: MeetingTranscriptLine[];
}

export interface MeetingTranscriptInput {
  sessionId: string;
  host: string;
  title: string;
  atMs: number;
  speaker?: string | null;
  source: string;
  translation: string;
}

export function transcriptSessionKey(sessionId: string): string {
  return `${MEETING_TRANSCRIPT_KEY_PREFIX}${sessionId}`;
}

export function isTranscriptSessionKey(key: string): boolean {
  return key.startsWith(MEETING_TRANSCRIPT_KEY_PREFIX);
}

/**
 * Appends one bilingual line, creating the meeting on first use.
 *
 * Returns the session to store, or the one passed in when there is nothing new
 * to write, so the caller can skip the storage round-trip. Never mutates: an
 * accidental in-place edit of the read value would silently diverge from what
 * is persisted.
 *
 * A stored line is never taken back or rewritten, and identical wording is not
 * treated as a repeat of the line above it: a meeting says "Okay." many times,
 * and each of them was said. Recording a settled cue exactly once is the
 * caller's job, not something guessed at from the text.
 */
export function appendTranscriptLine(
  session: MeetingTranscriptSession | null,
  input: MeetingTranscriptInput
): MeetingTranscriptSession | null {
  const source = input.source.trim();
  const translation = input.translation.trim();
  if (!input.sessionId || !source || !translation) {
    return session;
  }

  const line: MeetingTranscriptLine = {
    atMs: input.atMs,
    speaker: input.speaker?.trim() || null,
    source,
    translation
  };
  const lines = [...(session?.lines ?? []), line];
  return {
    sessionId: input.sessionId,
    host: session?.host ?? input.host,
    title: session?.title ?? input.title,
    startedAtMs: session?.startedAtMs ?? input.atMs,
    updatedAtMs: input.atMs,
    lines: lines.slice(Math.max(0, lines.length - MAX_TRANSCRIPT_LINES))
  };
}

/** Meetings still inside the retention window and the session cap, newest first. */
export function retainedTranscriptSessions(
  sessions: MeetingTranscriptSession[],
  nowMs: number,
  retentionDays: number
): MeetingTranscriptSession[] {
  const cutoff = retentionCutoff(nowMs, retentionDays);
  return listTranscriptSessions(sessions)
    .filter((session) => session.updatedAtMs >= cutoff)
    .slice(0, MAX_TRANSCRIPT_SESSIONS);
}

function retentionCutoff(nowMs: number, retentionDays: number): number {
  return nowMs - Math.max(1, retentionDays) * DAY_MS;
}

/** Storage keys of the meetings that have expired or fallen past the cap. */
export function expiredTranscriptKeys(
  sessions: MeetingTranscriptSession[],
  nowMs: number,
  retentionDays: number
): string[] {
  const retained = new Set(
    retainedTranscriptSessions(sessions, nowMs, retentionDays).map((session) => session.sessionId)
  );
  return sessions
    .filter((session) => !retained.has(session.sessionId))
    .map((session) => transcriptSessionKey(session.sessionId));
}

/** Newest first, so the options page and any export show recent meetings up top. */
export function listTranscriptSessions(
  sessions: MeetingTranscriptSession[]
): MeetingTranscriptSession[] {
  return [...sessions].sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

export function readTranscriptSession(value: unknown): MeetingTranscriptSession | null {
  return isTranscriptSession(value) ? value : null;
}

/** Every meeting in a `chrome.storage.local` snapshot, ignoring other keys. */
export function readTranscriptSessions(
  stored: Record<string, unknown>
): MeetingTranscriptSession[] {
  return Object.entries(stored)
    .filter(([key]) => isTranscriptSessionKey(key))
    .map(([, value]) => readTranscriptSession(value))
    .filter((session): session is MeetingTranscriptSession => session !== null);
}

function isTranscriptSession(value: unknown): value is MeetingTranscriptSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const session = value as MeetingTranscriptSession;
  return (
    typeof session.sessionId === "string" &&
    typeof session.host === "string" &&
    typeof session.title === "string" &&
    Number.isFinite(session.startedAtMs) &&
    Number.isFinite(session.updatedAtMs) &&
    Array.isArray(session.lines) &&
    session.lines.every(isTranscriptLine)
  );
}

function isTranscriptLine(value: unknown): value is MeetingTranscriptLine {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const line = value as MeetingTranscriptLine;
  return (
    Number.isFinite(line.atMs) &&
    (line.speaker === null || typeof line.speaker === "string") &&
    typeof line.source === "string" &&
    typeof line.translation === "string"
  );
}

/** A meeting the browser refused to write, and why it refused. */
export interface TranscriptFailure {
  reason: string;
  atMs: number;
}

/**
 * What is stored, and what stopped being stored, read straight out of a
 * `chrome.storage.local` snapshot.
 *
 * Both halves age out together here rather than at two call sites: a note
 * reported beside meetings it has outlived would tell the user a record was
 * cut short when that record is long gone.
 */
export function summarizeTranscripts(input: {
  stored: Record<string, unknown>;
  nowMs: number;
  retentionDays: number;
}): MeetingTranscriptSummary {
  const sessions = retainedTranscriptSessions(
    readTranscriptSessions(input.stored),
    input.nowMs,
    input.retentionDays
  );
  const failures = Object.values(
    retainedTranscriptFailures(
      readTranscriptFailures(input.stored[MEETING_TRANSCRIPT_FAILURE_KEY]),
      input.nowMs,
      input.retentionDays
    )
  );
  const newest = failures.reduce<TranscriptFailure | null>(
    (latest, failure) => (!latest || failure.atMs > latest.atMs ? failure : latest),
    null
  );
  return {
    sessions: sessions.length,
    lines: sessions.reduce((total, session) => total + session.lines.length, 0),
    retentionDays: input.retentionDays,
    stopped: newest ? { meetings: failures.length, reason: newest.reason } : null
  };
}

/**
 * The settings page's one line about the local records.
 *
 * A meeting that stopped being recorded is said here rather than only in the
 * live status the next caption overwrites, and it is said even when nothing
 * was stored at all — a first write that never landed is exactly the case the
 * user would otherwise never hear about.
 */
export function describeTranscriptSummary(
  summary: MeetingTranscriptSummary
): { state: "success" | "error"; text: string } {
  const stored =
    summary.sessions === 0
      ? "本机当前没有保存任何会议记录。"
      : `本机保存了 ${summary.sessions} 场会议、共 ${summary.lines} 行；` +
        `超过 ${summary.retentionDays} 天的记录会自动删除。`;
  if (!summary.stopped) {
    return { state: "success", text: stored };
  }
  return {
    state: "error",
    text:
      `${stored}有 ${summary.stopped.meetings} 场会议中途写入失败` +
      `（${summary.stopped.reason}），从那一刻起没有再被记录。` +
      "清除会议记录可以腾出空间并重新开始记录。"
  };
}

/**
 * The failures still worth telling the user about.
 *
 * A meeting stops being recorded at the moment of the refused write, so the
 * note about it ages exactly like the truncated record it describes: it is
 * kept for the same retention window and goes when that record goes, never
 * before. A meeting whose very first write was refused has no stored record
 * at all, and the same window is what keeps its note honest.
 */
export function retainedTranscriptFailures(
  failures: Record<string, TranscriptFailure>,
  nowMs: number,
  retentionDays: number
): Record<string, TranscriptFailure> {
  const cutoff = retentionCutoff(nowMs, retentionDays);
  return Object.fromEntries(
    Object.entries(failures).filter(([, failure]) => failure.atMs >= cutoff)
  );
}

/** Every recorded failure in a `chrome.storage.local` value, ignoring junk. */
export function readTranscriptFailures(value: unknown): Record<string, TranscriptFailure> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, TranscriptFailure] => {
      const failure = entry[1] as TranscriptFailure | null;
      return (
        typeof failure === "object" &&
        failure !== null &&
        typeof failure.reason === "string" &&
        Number.isFinite(failure.atMs)
      );
    })
  );
}
