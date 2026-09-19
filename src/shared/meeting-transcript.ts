/**
 * D7: a local bilingual transcript of a meeting, kept in `chrome.storage.local`
 * and deleted automatically after the retention window.
 *
 * This is deliberately a *store*, not a claim of no persistence: meeting mode
 * writes what was said and what we showed, and the options page says so and
 * offers a one-click wipe. Nothing here leaves the browser profile; the store
 * is written only by the background worker, which already runs behind
 * `TRUSTED_CONTEXTS`, so a content script can never read another tab's meeting.
 */

export const MEETING_TRANSCRIPT_STORAGE_KEY = "meeting-transcripts";

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

export type MeetingTranscriptStore = Record<string, MeetingTranscriptSession>;

export interface MeetingTranscriptInput {
  sessionId: string;
  host: string;
  title: string;
  atMs: number;
  speaker?: string | null;
  source: string;
  translation: string;
}

/**
 * Appends one bilingual line, creating the session on first use.
 *
 * Returns a new store rather than mutating: the caller reads storage, folds,
 * and writes back, and an accidental in-place edit of the read value would
 * silently diverge from what is persisted.
 */
export function appendTranscriptLine(
  store: MeetingTranscriptStore,
  input: MeetingTranscriptInput
): MeetingTranscriptStore {
  const source = input.source.trim();
  const translation = input.translation.trim();
  if (!input.sessionId || !source || !translation) {
    return store;
  }

  const existing = store[input.sessionId];
  const line: MeetingTranscriptLine = {
    atMs: input.atMs,
    speaker: input.speaker?.trim() || null,
    source,
    translation
  };
  // The same line can be re-recorded when a revision settles to identical
  // text; recording it twice would double every repeated phrase in the export.
  const previous = existing?.lines[existing.lines.length - 1];
  if (
    previous &&
    previous.source === line.source &&
    previous.translation === line.translation &&
    previous.speaker === line.speaker
  ) {
    return store;
  }

  const lines = [...(existing?.lines ?? []), line];
  const session: MeetingTranscriptSession = {
    sessionId: input.sessionId,
    host: existing?.host ?? input.host,
    title: existing?.title ?? input.title,
    startedAtMs: existing?.startedAtMs ?? input.atMs,
    updatedAtMs: input.atMs,
    lines: lines.slice(Math.max(0, lines.length - MAX_TRANSCRIPT_LINES))
  };

  return capSessions({ ...store, [input.sessionId]: session });
}

/** Drops every session whose last line is older than the retention window. */
export function pruneTranscripts(
  store: MeetingTranscriptStore,
  nowMs: number,
  retentionDays: number
): MeetingTranscriptStore {
  const cutoff = nowMs - Math.max(1, retentionDays) * DAY_MS;
  return capSessions(
    Object.fromEntries(
      Object.entries(store).filter(([, session]) => session.updatedAtMs >= cutoff)
    )
  );
}

/** Newest first, so the options page and any export show recent meetings up top. */
export function listTranscriptSessions(
  store: MeetingTranscriptStore
): MeetingTranscriptSession[] {
  return Object.values(store).sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

export function readTranscriptStore(value: unknown): MeetingTranscriptStore {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(([, session]) => isTranscriptSession(session))
  ) as MeetingTranscriptStore;
}

function capSessions(store: MeetingTranscriptStore): MeetingTranscriptStore {
  const sessions = listTranscriptSessions(store);
  if (sessions.length <= MAX_TRANSCRIPT_SESSIONS) {
    return store;
  }
  return Object.fromEntries(
    sessions.slice(0, MAX_TRANSCRIPT_SESSIONS).map((session) => [session.sessionId, session])
  );
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
