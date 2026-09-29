import { termKey } from "./terminology";
import type { ContextLine, EntityHint, SubtitleCue, TranslationResult } from "./types";

const MAX_CONTEXT_LINES = 8;
const MAX_ENTITY_HINTS = 30;
const MAX_CACHED_TRANSLATIONS = 120;
/** Text-keyed hits outlive per-cue ids so repeated Netflix lines skip the network. */
const MAX_CACHED_BY_TEXT = 200;

interface SessionMemory {
  recent: ContextLine[];
  entityHints: EntityHint[];
  cached: Map<string, TranslationResult>;
  cachedByText: Map<string, TranslationResult>;
  /** The language pair everything remembered here was translated for. */
  pair: string | null;
  /** This session is a call, so withdrawing consent to a record retracts it. */
  meeting: boolean;
  lastTouchedAt: number;
}

export interface PersistedTranslationSession {
  recent: ContextLine[];
  entityHints: EntityHint[];
  pair?: string;
  meeting?: boolean;
  lastTouchedAt: number;
}

export class TranslationSessionStore {
  private readonly sessions = new Map<string, SessionMemory>();

  /**
   * Points a session at the pair it is translating now.
   *
   * Everything a session remembers — the cached translations, the context the
   * model reads back, the renderings it learned for a name — is written in one
   * target language. When the user changes the pair mid-session that memory is
   * not stale by age but simply in the wrong language, so it goes rather than
   * coming back as a caption nobody asked for.
   */
  useLanguagePair(sessionId: string, sourceLanguage: string, targetLanguage: string): void {
    const pair = `${sourceLanguage}>${targetLanguage}`;
    const session = this.getSession(sessionId);
    if (session.pair === pair) {
      return;
    }
    if (session.pair !== null) {
      session.recent = [];
      session.entityHints = [];
      session.cached.clear();
      session.cachedByText.clear();
    }
    session.pair = pair;
  }

  /**
   * Marks a session as a call. Only these are retracted when the user
   * withdraws consent to a record of one — an episode being translated in
   * another tab is not a meeting and keeps its context and its caches.
   */
  markMeetingSession(sessionId: string): void {
    this.getSession(sessionId).meeting = true;
  }

  getContext(sessionId: string): ContextLine[] {
    return [...this.getSession(sessionId).recent];
  }

  getEntityHints(sessionId: string): EntityHint[] {
    return [...this.getSession(sessionId).entityHints];
  }

  getCached(sessionId: string, cueId: string): TranslationResult | undefined {
    return this.getSession(sessionId).cached.get(cueId);
  }

  getCachedByText(sessionId: string, text: string): TranslationResult | undefined {
    const key = text.trim();
    if (!key) {
      return undefined;
    }
    return this.getSession(sessionId).cachedByText.get(key);
  }

  record(sessionId: string, cue: SubtitleCue, translation: TranslationResult): void {
    const session = this.getSession(sessionId);
    const line: ContextLine = {
      cueId: cue.id,
      source: cue.text,
      translation: translation.text,
      atMs: Date.now(),
      ...(cue.speaker ? { speaker: cue.speaker } : {})
    };
    // One cue is one line of context. A meeting line is recorded again when it
    // settles, and appending it twice would spend half the model's window
    // repeating what it has already been told.
    const existing = session.recent.findIndex((entry) => entry.cueId === cue.id);
    if (existing >= 0) {
      session.recent[existing] = line;
    } else {
      session.recent.push(line);
    }
    session.recent.splice(0, Math.max(0, session.recent.length - MAX_CONTEXT_LINES));

    session.cached.set(cue.id, translation);
    while (session.cached.size > MAX_CACHED_TRANSLATIONS) {
      const oldestKey = session.cached.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      session.cached.delete(oldestKey);
    }

    this.storeByText(session, cue.text, translation);
    this.storeEntityHints(session, translation.entityHints);
    session.lastTouchedAt = Date.now();
    this.prune();
  }

  /**
   * Remembers a finished translation by its source text alone.
   *
   * The machine-translation channels have no cue to key on and never reach
   * the model's context window, but a line repeated later in the same session
   * should still skip the network rather than be paid for twice.
   */
  rememberText(sessionId: string, sourceText: string, translation: TranslationResult): void {
    const session = this.getSession(sessionId);
    this.storeByText(session, sourceText, translation);
    this.storeEntityHints(session, translation.entityHints);
    session.lastTouchedAt = Date.now();
    this.prune();
  }

  snapshot(sessionId: string): PersistedTranslationSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }
    return {
      recent: session.recent.map((line) => ({ ...line })),
      entityHints: session.entityHints.map((hint) => ({ ...hint })),
      ...(session.pair ? { pair: session.pair } : {}),
      ...(session.meeting ? { meeting: true } : {}),
      lastTouchedAt: session.lastTouchedAt
    };
  }

  restore(sessionId: string, value: unknown): void {
    if (!isPersistedSession(value)) {
      return;
    }
    const recent = value.recent.filter(isContextLine).slice(-MAX_CONTEXT_LINES);
    const entityHints = value.entityHints.filter(isEntityHint).slice(-MAX_ENTITY_HINTS);
    this.sessions.set(sessionId, {
      recent: recent.map((line) => ({ ...line })),
      entityHints: entityHints.map((hint) => ({ ...hint })),
      cached: new Map(),
      cachedByText: new Map(),
      pair: typeof value.pair === "string" ? value.pair : null,
      meeting: value.meeting === true,
      lastTouchedAt: Number.isFinite(value.lastTouchedAt) ? value.lastTouchedAt : Date.now()
    });
    this.prune();
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Forgets every call a worker is holding — the lines, the caches, and the
   * names the call registered along the way. A speaker's display name is part
   * of the record of who said what, not a term the user taught us, so it goes
   * with the rest; what the user typed into the glossary lives in settings
   * and is untouched.
   *
   * Sessions that are not calls are left exactly as they are: withdrawing
   * consent to a meeting record must not cost an episode its context window
   * mid-playback.
   */
  forgetMeetingSessions(): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.meeting) {
        this.sessions.delete(sessionId);
      }
    }
  }

  private storeByText(
    session: SessionMemory,
    sourceText: string,
    translation: TranslationResult
  ): void {
    const textKey = sourceText.trim();
    if (!textKey) {
      return;
    }
    // Re-insert so repeated lines refresh LRU order in the Map iteration.
    session.cachedByText.delete(textKey);
    session.cachedByText.set(textKey, translation);
    while (session.cachedByText.size > MAX_CACHED_BY_TEXT) {
      const oldestKey = session.cachedByText.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      session.cachedByText.delete(oldestKey);
    }
  }

  private storeEntityHints(session: SessionMemory, hints: EntityHint[]): void {
    for (const hint of hints) {
      const key = termKey(hint.source);
      const existingIndex = session.entityHints.findIndex(
        (entry) => termKey(entry.source) === key
      );
      if (existingIndex >= 0) {
        // A name registered as itself says nothing this session does not
        // already know, so it never overwrites a rendering someone worked out.
        if (hint.source === hint.target) {
          continue;
        }
        session.entityHints.splice(existingIndex, 1, hint);
      } else {
        session.entityHints.push(hint);
      }
    }
    session.entityHints.splice(0, Math.max(0, session.entityHints.length - MAX_ENTITY_HINTS));
  }

  private getSession(sessionId: string): SessionMemory {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastTouchedAt = Date.now();
      return existing;
    }
    const session: SessionMemory = {
      recent: [],
      entityHints: [],
      cached: new Map(),
      cachedByText: new Map(),
      pair: null,
      meeting: false,
      lastTouchedAt: Date.now()
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private prune(): void {
    const oldestFirst = [...this.sessions.entries()].sort(
      ([, left], [, right]) => left.lastTouchedAt - right.lastTouchedAt
    );
    for (const [sessionId] of oldestFirst.slice(0, Math.max(0, oldestFirst.length - 12))) {
      this.sessions.delete(sessionId);
    }
  }
}

function isPersistedSession(value: unknown): value is PersistedTranslationSession {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Array.isArray((value as PersistedTranslationSession).recent) &&
    Array.isArray((value as PersistedTranslationSession).entityHints);
}

function isContextLine(value: unknown): value is ContextLine {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const line = value as ContextLine;
  return (
    typeof line.cueId === "string" &&
    typeof line.source === "string" &&
    typeof line.translation === "string" &&
    typeof line.atMs === "number" &&
    Number.isFinite(line.atMs)
  );
}

function isEntityHint(value: unknown): value is EntityHint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const hint = value as EntityHint;
  return (
    typeof hint.source === "string" &&
    typeof hint.target === "string" &&
    (hint.kind === "term" || hint.kind === "name")
  );
}

export class SupersededJobError extends Error {
  constructor() {
    super("A newer subtitle superseded this translation job.");
    this.name = "SupersededJobError";
  }
}

export class SessionJobQueue {
  private readonly latestControllers = new Map<string, AbortController>();

  /**
   * Cancels the stale live-caption request and starts the newest one without
   * waiting for the old network stream to unwind. Stale results are rejected
   * before they can update session memory or the Overlay.
   */
  enqueueLatest<T>(
    sessionId: string,
    job: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    this.latestControllers.get(sessionId)?.abort();
    const controller = new AbortController();
    this.latestControllers.set(sessionId, controller);

    return (async () => {
      if (controller.signal.aborted) {
        throw new SupersededJobError();
      }
      try {
        const value = await job(controller.signal);
        if (controller.signal.aborted) {
          throw new SupersededJobError();
        }
        return value;
      } finally {
        if (this.latestControllers.get(sessionId) === controller) {
          this.latestControllers.delete(sessionId);
        }
      }
    })();
  }

  cancelLatest(sessionId: string): void {
    this.latestControllers.get(sessionId)?.abort();
    this.latestControllers.delete(sessionId);
  }
}
