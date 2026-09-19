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
 * The caption region. Semantic attributes come first because Meet's class
 * names are obfuscated and change between releases; `aria-label` is localized,
 * so the common scripts are listed explicitly.
 */
export const MEET_CAPTION_REGION_SELECTORS = [
  '[role="region"][aria-label*="aption" i]',
  '[role="region"][aria-label*="字幕"]',
  '[role="region"][aria-label*="자막"]',
  ".a4cQT"
] as const;

/** One speaker turn inside the region. Falls back to the region's children. */
export const MEET_CAPTION_BLOCK_SELECTORS = [".nMcdL", ".TBMuR"] as const;

/** The spoken text inside a turn. */
export const MEET_CAPTION_TEXT_SELECTORS = [
  '[jsname="tgaKEf"]',
  ".bh44bd",
  ".iTTPOb"
] as const;

/** The speaker's display name inside a turn. */
export const MEET_CAPTION_SPEAKER_SELECTORS = [".zs7s8d", ".KcIKyf"] as const;

export const MEET_NATIVE_HIDE_STYLE_ID = "tranlithion-hide-meet-captions";

/** A display name longer than this is almost certainly a sentence, not a name. */
export const MEET_MAX_SPEAKER_CHARS = 60;

/**
 * Longest run of recognizer output translated as one line when the recognizer
 * emits no punctuation at all. Without a cap a single long turn would be
 * retranslated in full on every revision.
 */
export const MEET_MAX_SEGMENT_CHARS = 160;

const REGION_POLL_INTERVAL_MS = 750;
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

export interface MeetCaptionBlock {
  speaker: string | null;
  text: string;
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
 * it, so a figure like "3.5" never splits a line.
 */
export function settledSegmentEnd(text: string): number {
  const terminators = /[。！？]+|[.!?]+(?=\s|$)/g;
  let cut = 0;
  for (let match = terminators.exec(text); match; match = terminators.exec(text)) {
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
 * Splits one rendered speaker turn into its name and its spoken text.
 *
 * Only the declared selectors are trusted. Guessing which row of an unknown
 * layout holds the display name would eventually label a fragment of speech as
 * a speaker and drop it from the translation; when the selectors stop matching
 * the turn reads as empty and the extension says it cannot see the captions.
 */
export function parseMeetCaptionBlock(block: Element): MeetCaptionBlock {
  return {
    speaker: usableSpeaker(pickText(block, MEET_CAPTION_SPEAKER_SELECTORS)),
    text: pickText(block, MEET_CAPTION_TEXT_SELECTORS)
  };
}

/** Every speaker turn currently rendered in the caption region, oldest first. */
export function readMeetCaptionBlocks(region: Element): MeetCaptionBlock[] {
  return captionBlockElements(region)
    .map((block) => parseMeetCaptionBlock(block))
    .filter((block) => block.text.length > 0);
}

export function nativeMeetCaptionHideCss(): string {
  return `${MEET_CAPTION_REGION_SELECTORS.join(", ")} { opacity: 0 !important; }`;
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
  /** Full text of the caption block this turn is being read from. */
  private blockText = "";
  /** Prefix of this turn already published as a finished segment. */
  private emitted = "";
  /** The published segment ended a sentence, so new words open a new cue. */
  private segmentClosed = false;
  /** Clock reading when the region last had text in it. */
  private lastTextAtMs = 0;

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
    this.pollTimer = window.setInterval(this.discoverRegion, REGION_POLL_INTERVAL_MS);
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
    removeNativeCaptionHideStyle();
    this.region = null;
    this.currentCue = null;
    this.speaker = null;
    this.blockText = "";
    this.emitted = "";
    this.segmentClosed = false;
    this.callback = null;
  }

  private readonly discoverRegion = (): void => {
    const nextRegion = findMeetCaptionRegion(this.region);
    if (nextRegion !== this.region) {
      this.observer?.disconnect();
      this.region = nextRegion;
      this.observer = null;
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
    this.setAvailability(Boolean(this.region));
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
    if (!this.currentCue) {
      return;
    }
    if (this.readLatestBlock()) {
      // Meet keeps the last line on screen after the speaker stops; the hold
      // only starts once the strip is actually clear.
      this.lastTextAtMs = this.clock.nowMs();
      return;
    }
    if (hasMeetCaptionExpired(this.lastTextAtMs, this.clock.nowMs())) {
      this.finishCurrentTurn();
    }
  };

  private readBlocks(): MeetCaptionBlock[] {
    return this.region ? readMeetCaptionBlocks(this.region) : [];
  }

  private readLatestBlock(): MeetCaptionBlock | null {
    const blocks = this.readBlocks();
    return blocks[blocks.length - 1] ?? null;
  }

  /**
   * Whether the newest block is a block we have not been reading, rather than
   * the one already open still growing.
   *
   * Meet merges a person's consecutive speech into one growing block and
   * starts a fresh block at a paragraph, so a new block ends the open line
   * even when the same person keeps talking. The recognizer also rewrites
   * words inside the block it is still growing, and that is a revision of the
   * open line — the block we were reading being pushed up the strip is what
   * tells the two apart.
   */
  private startsNewBlock(blocks: MeetCaptionBlock[]): boolean {
    const latest = blocks[blocks.length - 1];
    if (!this.blockText || !latest || latest.text.startsWith(this.blockText)) {
      return false;
    }
    return blocks.slice(0, -1).some((block) => block.text === this.blockText);
  }

  private readCaption(): void {
    const blocks = this.readBlocks();
    const latest = blocks[blocks.length - 1];
    if (!latest) {
      // A blank region is not evidence the turn is over; `tick` decides that.
      return;
    }
    this.lastTextAtMs = this.clock.nowMs();

    if (latest.speaker !== this.speaker || this.startsNewBlock(blocks)) {
      // Either a different person is talking or Meet started a new paragraph
      // for the same one: the previous turn is genuinely over either way.
      this.finishCurrentTurn();
      this.speaker = latest.speaker;
    }

    const full = latest.text;
    this.blockText = full;
    if (!full.startsWith(this.emitted)) {
      // The recognizer rewrote words it had already shown, so the prefix we
      // were counting from no longer exists. Start this turn's accounting over.
      this.emitted = "";
    }
    const remainder = full.slice(this.emitted.length);
    const pending = remainder.trimStart();
    if (!pending) {
      return;
    }

    const leading = remainder.length - pending.length;
    const cut = settledSegmentEnd(pending);
    if (cut <= 0) {
      this.publish(pending.trim());
      return;
    }

    this.emitted = full.slice(0, this.emitted.length + leading + cut);
    this.publish(pending.slice(0, cut).trim());
    // The sentence is complete, so whatever the speaker says next is a new
    // line rather than a revision of this one.
    this.segmentClosed = true;
    const rest = pending.slice(cut).trim();
    if (rest) {
      this.publish(rest);
    }
  }

  /**
   * Puts one segment on screen. Within a sentence this revises the open cue in
   * place, which keeps the translation already showing frozen rather than
   * blanking it on every recognizer update.
   */
  private publish(text: string): void {
    if (!text) {
      return;
    }
    if (this.currentCue && !this.segmentClosed) {
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
    this.blockText = "";
    this.emitted = "";
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
   * user pauses translation or hides the overlay for a screen share.
   */
  private applyNativeCaptionVisibility(): void {
    if (this.nativeCaptionsVisible) {
      removeNativeCaptionHideStyle();
      return;
    }
    ensureNativeCaptionHideStyle();
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
 * semantic attributes.
 */
export function findMeetCaptionRegion(preferredRegion: Element | null): Element | null {
  if (preferredRegion?.isConnected) {
    return preferredRegion;
  }
  for (const selector of MEET_CAPTION_REGION_SELECTORS) {
    const candidate = document.querySelector(selector);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function captionBlockElements(region: Element): Element[] {
  const explicit = Array.from(
    region.querySelectorAll(MEET_CAPTION_BLOCK_SELECTORS.join(", "))
  );
  if (explicit.length > 0) {
    return explicit;
  }
  // Meet renders one child per speaker turn even when its class names change.
  return Array.from(region.children);
}

function pickText(block: Element, selectors: readonly string[]): string {
  const matched = block.querySelector(selectors.join(", "));
  return matched ? normalizeSubtitleText(elementText(matched)) : "";
}

function usableSpeaker(speaker: string): string | null {
  return speaker && speaker.length <= MEET_MAX_SPEAKER_CHARS ? speaker : null;
}

function elementText(element: Element): string {
  const rendered = (element as HTMLElement).innerText;
  return typeof rendered === "string" && rendered ? rendered : element.textContent ?? "";
}
