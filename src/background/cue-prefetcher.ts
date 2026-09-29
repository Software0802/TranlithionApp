import type { SubtitleCue } from "../shared/types";

interface RunningPrefetch {
  cue: SubtitleCue;
  controller: AbortController;
  /** A caption that is due now is waiting on this answer; it is not dropped. */
  claimed: boolean;
  done: Promise<void>;
}

interface PrefetchSession {
  queue: SubtitleCue[];
  running: RunningPrefetch | null;
}

/**
 * Translates the lines a text track will show next, before they are due.
 *
 * A text track carries its whole timeline, so the next lines can be asked for
 * while the current one is still being read. By the time a line comes on
 * screen its translation is already in the session's cache, and the caption
 * lands with the line instead of a network round trip after it.
 *
 * One line at a time and in order, so each is translated with the lines
 * before it already in the session's context, exactly as it would be live. A
 * line the viewer has moved past — a seek, a skipped scene — is dropped as
 * soon as the next request stops asking for it, unless a caption is already
 * waiting on its answer.
 */
export class CuePrefetcher {
  private readonly sessions = new Map<string, PrefetchSession>();

  constructor(
    private readonly translate: (
      sessionId: string,
      cue: SubtitleCue,
      signal: AbortSignal
    ) => Promise<void>
  ) {}

  /**
   * The lines wanted ahead of playback now, replacing whatever was wanted
   * before. `isSettled` says which of them already have a translation.
   */
  schedule(
    sessionId: string,
    cues: SubtitleCue[],
    isSettled: (cue: SubtitleCue) => boolean
  ): void {
    const session = this.session(sessionId);
    const running = session.running;
    session.queue = cues.filter((cue) => cue.id !== running?.cue.id && !isSettled(cue));
    if (running && !running.claimed && !cues.some((cue) => cue.id === running.cue.id)) {
      running.controller.abort();
    }
    this.pump(sessionId, session);
  }

  /**
   * The prefetch already working on a line that is due now, so it is not asked
   * for twice; null when there is none. A line still waiting its turn leaves
   * the queue instead: the caller asks for it at once rather than behind the
   * lines queued ahead of it.
   */
  claim(sessionId: string, cueId: string): Promise<void> | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }
    session.queue = session.queue.filter((cue) => cue.id !== cueId);
    if (session.running?.cue.id !== cueId) {
      return null;
    }
    session.running.claimed = true;
    return session.running.done;
  }

  clear(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.sessions.delete(sessionId);
    session.queue = [];
    session.running?.controller.abort();
  }

  private session(sessionId: string): PrefetchSession {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    const session: PrefetchSession = { queue: [], running: null };
    this.sessions.set(sessionId, session);
    return session;
  }

  private pump(sessionId: string, session: PrefetchSession): void {
    if (session.running || this.sessions.get(sessionId) !== session) {
      return;
    }
    const cue = session.queue.shift();
    if (!cue) {
      // Nothing left ahead: an idle tab holds nothing here.
      this.sessions.delete(sessionId);
      return;
    }
    const controller = new AbortController();
    const job: RunningPrefetch = { cue, controller, claimed: false, done: Promise.resolve() };
    session.running = job;
    job.done = this.translate(sessionId, cue, controller.signal)
      .catch(() => undefined)
      .then(() => {
        if (session.running === job) {
          session.running = null;
        }
        this.pump(sessionId, session);
      });
  }
}
