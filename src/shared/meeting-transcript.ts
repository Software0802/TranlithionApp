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

/** One meeting per key: `meeting-transcript:<sessionId>`. */
export const MEETING_TRANSCRIPT_KEY_PREFIX = "meeting-transcript:";

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
  /**
   * Wording the recognizer withdrew. A live caption rewrites sentences it has
   * already finished, and the transcript is a record of what was said, not of
   * every attempt at hearing it, so a stored line the correction supersedes is
   * dropped rather than kept beside it.
   */
  replaces?: string[];
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
  const kept = withoutRetracted(session?.lines ?? [], input.replaces);
  // The same line can be re-recorded when a revision settles to identical
  // text; recording it twice would double every repeated phrase in the export.
  const previous = kept[kept.length - 1];
  const duplicate =
    previous !== undefined &&
    previous.source === line.source &&
    previous.translation === line.translation &&
    previous.speaker === line.speaker;
  if (duplicate && session && kept === session.lines) {
    return session;
  }

  const lines = duplicate ? kept : [...kept, line];
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
  const cutoff = nowMs - Math.max(1, retentionDays) * DAY_MS;
  return listTranscriptSessions(sessions)
    .filter((session) => session.updatedAtMs >= cutoff)
    .slice(0, MAX_TRANSCRIPT_SESSIONS);
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

function withoutRetracted(
  lines: MeetingTranscriptLine[],
  replaces: string[] | undefined
): MeetingTranscriptLine[] {
  if (!replaces?.length) {
    return lines;
  }
  const withdrawn = new Set(replaces.map((text) => text.trim()).filter(Boolean));
  let end = lines.length;
  while (end > 0 && withdrawn.has(lines[end - 1].source)) {
    end -= 1;
  }
  return end === lines.length ? lines : lines.slice(0, end);
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
