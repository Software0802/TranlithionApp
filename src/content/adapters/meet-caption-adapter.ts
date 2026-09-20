import { createSubtitleCue, normalizeSubtitleText } from "../../shared/subtitle";
import type { SubtitleCue } from "../../shared/types";
import type { ClockSource } from "../clock";
import type { SubtitleAdapter, SubtitleAdapterEvent } from "./types";

/**
 * Google Meet's own live captions, read from the caption region Meet already
 * renders into the page.
 *
 * Nothing here touches audio, the microphone, tab capture, or any Meet
 * internal: if the user has not switched captions on, this adapter reports the
 * source as unavailable and the extension says so.
 *
 * Two things differ from the film adapters. There is no single `<video>` whose
 * `currentTime` tracks the conversation, so every timing decision here uses the
 * injected wall clock. And the captions are speech recognition output: one
 * speaker turn is rewritten many times a second, grows across sentences, and
 * carries a speaker name that belongs beside the translation rather than
 * inside it.
 */

/**
 * Candidate caption containers, semantic first, because Meet's class names are
 * obfuscated and change between releases.
 *
 * Nothing here reads `aria-label`: that text is localized, so matching it would
 * only work in the handful of languages we happened to list. A candidate is
 * accepted on its role plus a structural check — it has to actually contain
 * Meet's caption rows — which holds in every locale.
 */
export const MEET_CAPTION_REGION_SELECTORS = [
  '[role="region"][aria-live]',
  '[role="region"]',
  ".a4cQT"
] as const;

/**
 * One speaker turn inside the region. Nothing else counts as a turn: picking
 * arbitrary children of an unknown layout would read the oldest line on the
 * strip forever while new speech scrolled past it, and say nothing about it.
 */
export const MEET_CAPTION_BLOCK_SELECTORS = [".nMcdL"] as const;

/** The spoken text inside a turn. */
export const MEET_CAPTION_TEXT_SELECTORS = ['[jsname="tgaKEf"]', ".bh44bd"] as const;

/** The speaker's display name inside a turn. */
export const MEET_CAPTION_SPEAKER_SELECTORS = [".zs7s8d"] as const;

export const MEET_NATIVE_HIDE_STYLE_ID = "tranlithion-hide-meet-captions";

/**
 * Marks the one region the adapter is reading. The hide stylesheet keys off
 * this attribute rather than the region selectors, so nothing else on the page
 * can be dimmed by a selector that happens to match it too.
 */
export const MEET_NATIVE_HIDE_ATTRIBUTE = "data-tranlithion-meet-captions";

/**
 * Longest run of recognizer output translated as one line when the recognizer
 * emits no punctuation at all. Without a cap a single long turn would be
 * retranslated in full on every revision.
 */
export const MEET_MAX_SEGMENT_CHARS = 160;

/** How often to look for the caption region before one has been found. */
export const MEET_REGION_POLL_INTERVAL_MS = 750;
/** Collapse the burst of mutations Meet emits for one recognizer update. */
export const MEET_CAPTION_SETTLE_DELAY_MS = 16;
/** How often to re-check whether a silent caption region means the turn ended. */
const CAPTION_TICK_INTERVAL_MS = 200;
/**
 * A cue ends on the wall clock, because a meeting page has no playback
 * position to measure against. An empty region is still not an immediate end:
 * Meet clears and repaints the caption strip between recognizer updates, and
 * treating the first blank read as the end of the turn produces the same
 * flicker the Netflix adapter was built to avoid.
 */
export const MEET_CAPTION_HOLD_MS = 1_600;
/**
 * How long the caption region may show text no selector can read before the
 * adapter calls the source unreadable, gives the user Meet's own captions back
 * and says so. The window absorbs a repaint caught mid-flight; a strip that is
 * merely empty between utterances never enters this state at all.
 */
export const MEET_CAPTION_UNREADABLE_GRACE_MS = 2_000;

export interface MeetCaptionBlock {
  speaker: string | null;
  text: string;
}

/** One rendered turn together with the node it was read from. */
export interface MeetCaptionEntry {
  element: Element;
  block: MeetCaptionBlock;
}

/**
 * Whether a caption region that has stopped producing text means the speaker
 * turn is over. `lastTextAtMs` and `nowMs` both come from the injected clock.
 */
export function hasMeetCaptionExpired(lastTextAtMs: number, nowMs: number): boolean {
  const elapsed = nowMs - lastTextAtMs;
  return elapsed < 0 || elapsed >= MEET_CAPTION_HOLD_MS;
}

/**
 * Where the settled part of a growing recognizer line ends, as an index into
 * `text`, or 0 when nothing has settled yet.
 *
 * A Latin full stop only counts when whitespace or the end of the line follows
 * it, so a figure like "3.5" never splits a line, and never when the stop
 * belongs to the word in front of it.
 */
export function settledSegmentEnd(text: string): number {
  const terminators = /[。！？]+|[.!?]+(?=\s|$)/g;
  let cut = 0;
  for (let match = terminators.exec(text); match; match = terminators.exec(text)) {
    if (ABBREVIATED_WORD_END.test(text.slice(0, match.index))) {
      continue;
    }
    cut = match.index + match[0].length;
  }
  if (cut > 0) {
    return cut;
  }
  if (text.length <= MEET_MAX_SEGMENT_CHARS) {
    return 0;
  }
  // The recognizer is producing no punctuation. Cut on the last word boundary
  // before the cap so the line stays translatable and bounded.
  const head = text.slice(0, MEET_MAX_SEGMENT_CHARS);
  const boundary = head.lastIndexOf(" ");
  return boundary > MEET_MAX_SEGMENT_CHARS / 2 ? boundary + 1 : MEET_MAX_SEGMENT_CHARS;
}

/**
 * A word whose full stop is part of the word: a title or an initial, not the
 * end of a sentence.
 *
 * Keyed on capitalization rather than on a list of words, because a meeting
 * is full of names nobody can list in advance. A capitalized token of one or
 * two letters is a title or an initial ("Mr", "Dr", "St", "J"), and so is a
 * run of single capitals joined by stops ("U.S"). Everything else ends the
 * sentence it finishes — 「Fine.」 and 「I said no.」 still settle — except the
 * three Latin abbreviations that break the rule, named here and nowhere else.
 *
 * A stop it catches holds the sentence open rather than ending it, because a
 * single read cannot tell 「Mr.」 from 「No.」 — at that instant they look the
 * same. What follows decides: the next read of the same block carries on
 * into the name and the two become one segment, while a turn that ends there
 * settles what was held, so a one-word answer is still translated once.
 */
const ABBREVIATED_WORD_END = /(?:^|\s)(?:\p{Lu}\p{Ll}?|(?:\p{Lu}\.)+\p{Lu}|e\.g|i\.e|etc)$/u;

/**
 * Splits one rendered speaker turn into its name and its spoken text.
 *
 * Only the declared selectors are trusted. Guessing which row of an unknown
 * layout holds the display name would eventually label a fragment of speech as
 * a speaker and drop it from the translation; when the selectors stop matching
 * the turn reads as empty and the extension says it cannot see the captions.
 */
export function parseMeetCaptionBlock(block: Element): MeetCaptionBlock {
  return {
    speaker: pickText(block, MEET_CAPTION_SPEAKER_SELECTORS) || null,
    text: pickText(block, MEET_CAPTION_TEXT_SELECTORS)
  };
}

/** Every speaker turn currently rendered in the caption region, oldest first. */
export function readMeetCaptionEntries(region: Element): MeetCaptionEntry[] {
  return captionBlockElements(region)
    .map((element) => ({ element, block: parseMeetCaptionBlock(element) }))
    .filter((entry) => entry.block.text.length > 0);
}

export function readMeetCaptionBlocks(region: Element): MeetCaptionBlock[] {
  return readMeetCaptionEntries(region).map((entry) => entry.block);
}

export function nativeMeetCaptionHideCss(): string {
  return `[${MEET_NATIVE_HIDE_ATTRIBUTE}] { opacity: 0 !important; }`;
}

export class MeetCaptionAdapter implements SubtitleAdapter {
  readonly source = "meet-dom" as const;

  private callback: ((event: SubtitleAdapterEvent) => void) | null = null;
  private observer: MutationObserver | null = null;
  private region: Element | null = null;
  private currentCue: SubtitleCue | null = null;
  private settleTimer: number | null = null;
  private pollTimer: number | null = null;
  private tickTimer: number | null = null;
  private lastAvailability: boolean | null = null;
  private nativeCaptionsVisible = true;
  /** Speaker of the turn currently being read. */
  private speaker: string | null = null;
  /** The caption block this turn is being read from. */
  private blockElement: Element | null = null;
  /** Its full text as of the last read. */
  private blockText = "";
  /** Prefix of this turn already published as a finished segment. */
  private emitted = "";
  /** End offset of each finished segment published from this block, oldest first. */
  private settledEnds: number[] = [];
  /** The published segment ended a sentence, so new words open a new cue. */
  private segmentClosed = false;
  /** Clock reading when the region last had text in it. */
  private lastTextAtMs = 0;
  /** A caption row has been parsed out of this region. */
  private captionsReadable = false;
  /** Clock reading when the region first showed text nothing could parse. */
  private unreadableSinceMs: number | null = null;

  constructor(private readonly clock: ClockSource) {}

  setNativeCaptionVisibility(visible: boolean): void {
    this.nativeCaptionsVisible = visible;
    this.applyNativeCaptionVisibility();
  }

  start(onEvent: (event: SubtitleAdapterEvent) => void): void {
    this.callback = onEvent;
    this.lastTextAtMs = this.clock.nowMs();
    this.applyNativeCaptionVisibility();
    this.discoverRegion();
    this.pollTimer = window.setInterval(this.discoverRegion, MEET_REGION_POLL_INTERVAL_MS);
    // Mutations stop arriving once the speaker stops talking, so ending a turn
    // needs its own heartbeat rather than a DOM event that will never come.
    this.tickTimer = window.setInterval(this.tick, CAPTION_TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.observer?.disconnect();
    this.observer = null;
    this.nativeCaptionsVisible = true;
    this.captionsReadable = false;
    this.unreadableSinceMs = null;
    this.applyNativeCaptionVisibility();
    this.region = null;
    this.currentCue = null;
    this.speaker = null;
    this.blockElement = null;
    this.blockText = "";
    this.emitted = "";
    this.settledEnds = [];
    this.segmentClosed = false;
    this.callback = null;
  }

  private readonly discoverRegion = (): void => {
    const nextRegion = findMeetCaptionRegion(this.region);
    if (nextRegion !== this.region) {
      this.observer?.disconnect();
      this.region?.removeAttribute(MEET_NATIVE_HIDE_ATTRIBUTE);
      this.region = nextRegion;
      this.observer = null;
      this.captionsReadable = false;
      this.unreadableSinceMs = null;
      this.applyNativeCaptionVisibility();
      if (this.region) {
        this.observer = new MutationObserver(this.scheduleRead);
        this.observer.observe(this.region, {
          childList: true,
          subtree: true,
          characterData: true
        });
        this.scheduleRead();
      }
    }
    this.refreshAvailability();
  };

  private readonly scheduleRead = (): void => {
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
    }
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      this.readCaption();
    }, MEET_CAPTION_SETTLE_DELAY_MS);
  };

  /** Ends the turn once the caption region has stayed silent long enough. */
  private readonly tick = (): void => {
    const entries = this.readEntries();
    this.noteReadability(entries);
    if (!this.currentCue) {
      return;
    }
    if (entries.length > 0) {
      // Meet keeps the last line on screen after the speaker stops; the hold
      // only starts once the strip is actually clear.
      this.lastTextAtMs = this.clock.nowMs();
      return;
    }
    if (hasMeetCaptionExpired(this.lastTextAtMs, this.clock.nowMs())) {
      this.finishCurrentTurn();
    }
  };

  private readEntries(): MeetCaptionEntry[] {
    return this.region ? readMeetCaptionEntries(this.region) : [];
  }

  /**
   * Whether the newest row is a block we have not been reading, rather than
   * the one already open still growing.
   *
   * Meet merges a person's consecutive speech into one growing block and
   * starts a fresh block at a paragraph, so a new block ends the open line
   * even when the same person keeps talking. The node the row is rendered in
   * is what tells the two apart: the recognizer rewrites the text of the block
   * it is still growing, so comparing text would take an edit for a new
   * paragraph. Re-rendered nodes are the one exception — text that carries on
   * from where we were reading is still the same line.
   */
  private startsNewBlock(latest: MeetCaptionEntry): boolean {
    if (!this.blockElement || latest.element === this.blockElement) {
      return false;
    }
    return !latest.block.text.startsWith(this.blockText);
  }

  private readCaption(): void {
    const entries = this.readEntries();
    this.noteReadability(entries);
    const latest = entries[entries.length - 1];
    if (!latest) {
      // A blank region is not evidence the turn is over; `tick` decides that.
      return;
    }
    this.lastTextAtMs = this.clock.nowMs();

    if (latest.block.speaker !== this.speaker || this.startsNewBlock(latest)) {
      // Either a different person is talking or Meet started a new paragraph
      // for the same one: the previous turn is genuinely over either way.
      this.finishCurrentTurn();
      this.speaker = latest.block.speaker;
    }

    const full = latest.block.text;
    const corrects = !full.startsWith(this.emitted);
    if (corrects) {
      this.dropWithdrawnSegments(full);
    }
    this.blockElement = latest.element;
    this.blockText = full;
    const remainder = full.slice(this.emitted.length);
    const pending = remainder.trimStart();
    if (!pending) {
      return;
    }

    const leading = remainder.length - pending.length;
    const cut = settledSegmentEnd(pending);
    if (cut <= 0) {
      this.publish(pending.trim(), corrects);
      return;
    }

    const settled = pending.slice(0, cut).trim();
    this.emitted = full.slice(0, this.emitted.length + leading + cut);
    this.settledEnds.push(this.emitted.length);
    this.publish(settled, corrects);
    // The sentence is complete, so whatever the speaker says next is a new
    // line rather than a revision of this one.
    this.segmentClosed = true;
    const rest = pending.slice(cut).trim();
    if (rest) {
      this.publish(rest);
    }
  }

  /**
   * Re-aligns the published prefix after the recognizer rewrote wording it had
   * already shown.
   *
   * The sentences the rewrite left untouched stay published, so they are
   * neither retranslated nor recorded twice. Everything after them is put back
   * into the open cue, which the caller then revises in place instead of
   * ending it on wording the recognizer took back.
   */
  private dropWithdrawnSegments(full: string): void {
    let keep = this.settledEnds.length;
    while (keep > 0 && !full.startsWith(this.blockText.slice(0, this.settledEnds[keep - 1]))) {
      keep -= 1;
    }
    this.settledEnds = this.settledEnds.slice(0, keep);
    this.emitted = keep > 0 ? this.blockText.slice(0, this.settledEnds[keep - 1]) : "";
  }

  /**
   * Tracks whether the captions can actually be read, which is what decides
   * whether hiding Meet's own strip is safe.
   *
   * An empty strip says nothing either way — Meet clears it between utterances
   * and hiding an empty strip costs the user nothing. Text we cannot parse is
   * the real failure: the selectors have moved, and every second we keep the
   * strip hidden is a second of captions the user could have read.
   */
  private noteReadability(entries: MeetCaptionEntry[]): void {
    if (entries.length > 0) {
      this.unreadableSinceMs = null;
      if (!this.captionsReadable) {
        this.captionsReadable = true;
        this.applyNativeCaptionVisibility();
      }
      this.refreshAvailability();
      return;
    }
    if (!this.region || !regionHasUnreadableText(this.region)) {
      this.unreadableSinceMs = null;
      this.refreshAvailability();
      return;
    }
    this.unreadableSinceMs ??= this.clock.nowMs();
    if (this.captionsUnreadable() && this.captionsReadable) {
      this.captionsReadable = false;
      this.applyNativeCaptionVisibility();
    }
    this.refreshAvailability();
  }

  private captionsUnreadable(): boolean {
    return (
      this.unreadableSinceMs !== null &&
      this.clock.nowMs() - this.unreadableSinceMs >= MEET_CAPTION_UNREADABLE_GRACE_MS
    );
  }

  /**
   * Puts one segment on screen. Within a sentence this revises the open cue in
   * place, which keeps the translation already showing frozen rather than
   * blanking it on every recognizer update.
   */
  private publish(text: string, corrects = false): void {
    if (!text) {
      return;
    }
    // A correction replaces the line on screen even when that line had already
    // finished a sentence: the recognizer withdrew those words, so ending the
    // cue would hand withdrawn wording to the translator and the transcript as
    // if it had been spoken.
    if (this.currentCue && (!this.segmentClosed || corrects)) {
      if (this.currentCue.text === text) {
        // Meet repaints the strip without changing a word; re-emitting would
        // cancel the translation in flight for the line already on screen.
        return;
      }
    } else if (this.currentCue) {
      this.finishCurrentCue();
    }

    if (this.currentCue) {
      const previousCueId = this.currentCue.id;
      const revised = this.createCue(text, this.currentCue.startMs);
      if (!revised) {
        return;
      }
      this.currentCue = revised;
      this.segmentClosed = false;
      this.emit({
        type: "cue-revise",
        source: this.source,
        cue: revised,
        previousCueId
      });
      return;
    }

    const cue = this.createCue(text, this.clock.nowMs());
    if (!cue) {
      return;
    }
    this.segmentClosed = false;
    this.currentCue = cue;
    this.emit({ type: "cue-start", source: this.source, cue });
  }

  private createCue(text: string, startMs: number): SubtitleCue | null {
    return createSubtitleCue({
      source: this.source,
      startMs,
      endMs: null,
      text,
      isFinal: true,
      speaker: this.speaker ?? undefined
    });
  }

  /** Ends the open cue and forgets the turn's published prefix. */
  private finishCurrentTurn(): void {
    this.finishCurrentCue();
    this.blockElement = null;
    this.blockText = "";
    this.emitted = "";
    this.settledEnds = [];
    this.segmentClosed = false;
  }

  private finishCurrentCue(): void {
    if (!this.currentCue) {
      return;
    }
    this.emit({
      type: "cue-end",
      source: this.source,
      cueId: this.currentCue.id,
      atMs: Math.round(this.clock.nowMs())
    });
    this.currentCue = null;
    this.segmentClosed = false;
  }

  /**
   * Hides Meet's own caption strip through a document stylesheet while the
   * translation is on, so the two do not stack on top of each other. The text
   * stays readable to `innerText`, and the strip comes straight back when the
   * user pauses translation, hides the overlay for a screen share, or the
   * captions stop being readable at all.
   *
   * Nothing is hidden until a row has actually been parsed out of this region:
   * hiding captions we cannot replace would leave the user with a blank strip.
   */
  private applyNativeCaptionVisibility(): void {
    if (this.nativeCaptionsVisible || !this.captionsReadable || !this.region) {
      this.region?.removeAttribute(MEET_NATIVE_HIDE_ATTRIBUTE);
      removeNativeCaptionHideStyle();
      return;
    }
    ensureNativeCaptionHideStyle();
    this.region.setAttribute(MEET_NATIVE_HIDE_ATTRIBUTE, "");
  }

  private refreshAvailability(): void {
    this.setAvailability(Boolean(this.region) && !this.captionsUnreadable());
  }

  private setAvailability(available: boolean): void {
    if (this.lastAvailability === available) {
      return;
    }
    this.lastAvailability = available;
    this.emit({ type: "availability", source: this.source, available });
  }

  private emit(event: SubtitleAdapterEvent): void {
    this.callback?.(event);
  }
}

function ensureNativeCaptionHideStyle(): void {
  if (document.getElementById(MEET_NATIVE_HIDE_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = MEET_NATIVE_HIDE_STYLE_ID;
  style.textContent = nativeMeetCaptionHideCss();
  (document.head ?? document.documentElement).append(style);
}

function removeNativeCaptionHideStyle(): void {
  document.getElementById(MEET_NATIVE_HIDE_STYLE_ID)?.remove();
}

/**
 * The caption region currently in the page, preferring the one already being
 * read. Selectors are tried in order, so a renamed class cannot win over the
 * semantic attributes, and a candidate only counts once it is carrying Meet's
 * caption rows — which is what keeps `[role="region"]` from matching the rest
 * of the meeting UI.
 */
export function findMeetCaptionRegion(preferredRegion: Element | null): Element | null {
  if (preferredRegion?.isConnected) {
    return preferredRegion;
  }
  for (const selector of MEET_CAPTION_REGION_SELECTORS) {
    for (const candidate of Array.from(document.querySelectorAll(selector))) {
      if (candidate.querySelector(MEET_CAPTION_STRUCTURE_SELECTOR)) {
        return candidate;
      }
    }
  }
  return null;
}

/** What a caption strip is made of, whichever of the two layouts Meet ships. */
const MEET_CAPTION_STRUCTURE_SELECTOR = [
  ...MEET_CAPTION_BLOCK_SELECTORS,
  ...MEET_CAPTION_TEXT_SELECTORS
].join(", ");

/**
 * Whether the strip is showing words none of the declared selectors can
 * reach — the state that means Meet has moved them.
 *
 * A row the parser read correctly does not count, and neither does a row
 * Meet has attributed to a speaker before the recognizer has emitted a word:
 * there is a name on screen, but no speech is being withheld from the user.
 */
function regionHasUnreadableText(region: Element): boolean {
  const blocks = captionBlockElements(region);
  if (blocks.length === 0) {
    return normalizeSubtitleText(elementText(region)).length > 0;
  }
  return blocks.some((block) => blockHidesText(block));
}

function blockHidesText(block: Element): boolean {
  if (pickText(block, MEET_CAPTION_TEXT_SELECTORS)) {
    return false;
  }
  const rendered = normalizeSubtitleText(elementText(block));
  return rendered.length > 0 && rendered !== pickText(block, MEET_CAPTION_SPEAKER_SELECTORS);
}

function captionBlockElements(region: Element): Element[] {
  return Array.from(region.querySelectorAll(MEET_CAPTION_BLOCK_SELECTORS.join(", ")));
}

function pickText(block: Element, selectors: readonly string[]): string {
  const matched = block.querySelector(selectors.join(", "));
  return matched ? normalizeSubtitleText(elementText(matched)) : "";
}

function elementText(element: Element): string {
  const rendered = (element as HTMLElement).innerText;
  return typeof rendered === "string" && rendered ? rendered : element.textContent ?? "";
}
