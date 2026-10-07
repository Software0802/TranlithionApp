import { languageLabel, type LanguageTag } from "../../shared/language";
import {
  detectTextLanguage,
  emptyScriptTally,
  hasLetters,
  PAGE_MAX_ITEM_CHARS,
  pageEngineLabel,
  pageLanguageContext,
  tallyScripts,
  type PageLanguageContext,
  type ScriptTally
} from "../../shared/page-translation";
import type { PublicTranslationSettings } from "../../shared/types";
import { PageChannelError, type PageChannel } from "./channels";
import {
  collapseWhitespace,
  layoutOf,
  parseMarkup,
  placeSlotTexts,
  serializeMarkup
} from "./markup";
import {
  blockContainerOf,
  containerOf,
  extractUnits,
  isInsideExcluded,
  TextScanner,
  type PageUnit
} from "./segmenter";

/**
 * One-click translation of a whole page, built around two promises Chrome's
 * own page translation does not keep on heavy pages:
 *
 * - **The page keeps working.** Only the `data` of text nodes the page already
 *   has is ever written. No node is created, wrapped, moved or removed, so a
 *   framework that holds references to its text nodes (React, Vue, Svelte…)
 *   finds them where it left them. Editors, form controls and code are never
 *   touched. When the page rewrites text it owns, the translation steps aside
 *   and is re-applied from cache; text the page keeps fighting over is left
 *   in the original.
 * - **It is fast where the reader is looking.** The page is read in short
 *   time slices so it never freezes; only text on or near the screen is
 *   translated, closest first, in batches; identical strings are translated
 *   once; and whatever scrolls into view later is picked up as it approaches.
 */

export type PageTranslationPhase =
  /** Showing the original. */
  | "idle"
  /** Reading the page or waiting for translations. */
  | "working"
  /** Everything near the screen is translated; new text is picked up as it comes. */
  | "settled"
  /** Chrome needs one click on the page to set up its local model. */
  | "needs-activation"
  | "error";

export interface PageTranslationView {
  phase: PageTranslationPhase;
  /** Segments whose translation is on the page. */
  translated: number;
  /** Strings waiting for or inside a request. */
  pending: number;
  message: string;
  target: LanguageTag;
  engineLabel: string;
}

interface ContainerState {
  /** `watching`: waiting to come near the screen. `done`: read and planned. */
  status: "watching" | "done" | "volatile";
  /**
   * Translated text node by text node rather than sentence by sentence,
   * because the page keeps rewriting one value inside it.
   */
  perNode: boolean;
  units: PageUnit[];
  /** When the page rewrote this container's text under a translation. */
  rewrites: number[];
  /** Work items still waiting to write into this container. */
  pending: number;
  /** Distance from the screen; far away once it has scrolled out of range. */
  priority: number;
}

interface NodeRecord {
  original: string;
  applied: string;
  container: Element;
}

type WorkTarget =
  | { kind: "markup"; unit: PageUnit }
  | { kind: "run"; unit: PageUnit; token: number };

interface WorkItem {
  key: string;
  text: string;
  source: LanguageTag;
  markup: boolean;
  /** Order of arrival, which breaks ties between equally urgent strings. */
  seq: number;
  targets: WorkTarget[];
}

/** Text within this many viewport heights of the screen is translated ahead of scrolling. */
const PREFETCH_MARGIN = "150% 0px 150% 0px";
/** Priority of a container that has scrolled out of range. */
const OUT_OF_RANGE = Number.MAX_SAFE_INTEGER;
/** How long one reading slice may hold the main thread. */
const SCAN_SLICE_MS = 8;
/** A container the page rewrites more often than this is left in the original. */
const MAX_REWRITES = 6;
const REWRITE_WINDOW_MS = 10_000;
/** Text that must be seen before bare Han characters are judged Japanese or Chinese. */
const TALLY_SAMPLE_CHARS = 20_000;
const MAX_CACHED = 4_000;
const PRUNE_INTERVAL_MS = 30_000;
const VIEW_THROTTLE_MS = 200;
/** New content is read after the page has finished adding it. */
const ADDED_CONTENT_DELAY_MS = 120;

const MUTATION_OPTIONS: MutationObserverInit = {
  childList: true,
  characterData: true,
  subtree: true
};

export interface PageTranslatorOptions {
  /** The subtree to translate; normally `document.body`. */
  root: () => Element | null;
  /** The page's declared language, `<html lang>`. */
  langAttribute: () => string | null;
  createChannel: (settings: PublicTranslationSettings) => PageChannel;
  onChange: (view: PageTranslationView) => void;
}

export class PageTranslator {
  private phase: PageTranslationPhase = "idle";
  private message = "";
  private generation = 0;
  private channel: PageChannel | null = null;
  private channelKey = "";
  private root: Element | null = null;
  private target: LanguageTag;

  private intersection: IntersectionObserver | null = null;
  private mutations: MutationObserver | null = null;
  private scanners: TextScanner[] = [];
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private addedTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly addedRoots = new Set<Node>();
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private viewTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly containers = new Map<Element, ContainerState>();
  /** Containers the intersection observer has not reported on yet. */
  private readonly unnoticed = new Set<Element>();
  private readonly records = new Map<Text, NodeRecord>();
  /** Text nodes whose text some translation (sent, cached or written) was made from. */
  private readonly plannedNodes = new WeakSet<Text>();
  private readonly work = new Map<string, WorkItem>();
  private queue: WorkItem[] = [];
  private inflight = 0;
  private seq = 0;
  private readonly cache = new Map<string, string>();
  private pendingWrites: Array<{ unit: PageUnit; writes: Array<[Text, string]> }> = [];

  private tally: ScriptTally = emptyScriptTally();
  private tallied = 0;
  private translatedCount = 0;
  private plannedCount = 0;

  constructor(
    private settings: PublicTranslationSettings,
    private readonly options: PageTranslatorOptions
  ) {
    this.target = settings.targetLanguage;
  }

  /** Whether the page shows (or is getting) a translation that `restore` would undo. */
  isActive(): boolean {
    return this.phase !== "idle";
  }

  view(): PageTranslationView {
    return {
      phase: this.phase,
      translated: this.translatedCount,
      pending: this.work.size,
      message: this.message || this.describe(),
      target: this.target,
      engineLabel: this.channel ? pageEngineLabel(this.channel.engine) : ""
    };
  }

  /** Starts translating the page. Does nothing when it is already translated. */
  start(): PageTranslationView {
    if (this.isActive()) {
      return this.view();
    }
    if (!this.settings.enabled) {
      return this.refuse("翻译已暂停。请先在扩展弹窗里重新开启。");
    }
    const root = this.options.root();
    if (!root) {
      return this.refuse("这个页面没有可以翻译的正文。");
    }
    this.generation += 1;
    this.root = root;
    this.target = this.settings.targetLanguage;
    this.channel = this.channelFor(this.settings);
    this.tally = emptyScriptTally();
    this.tallied = 0;
    this.translatedCount = 0;
    this.plannedCount = 0;
    this.message = "";
    this.phase = "working";

    this.intersection = new IntersectionObserver(this.onIntersect, {
      rootMargin: PREFETCH_MARGIN
    });
    this.mutations = new MutationObserver(this.onMutations);
    this.mutations.observe(root, MUTATION_OPTIONS);
    this.scanners = [new TextScanner(root, this.onText)];
    this.pruneTimer = setInterval(this.prune, PRUNE_INTERVAL_MS);
    this.scheduleScan(0);
    this.emit(true);
    return this.view();
  }

  /** Puts the original text back wherever the page has not changed it since. */
  restore(): { restored: number } {
    if (!this.isActive()) {
      return { restored: 0 };
    }
    this.generation += 1;
    this.mutations?.disconnect();
    this.intersection?.disconnect();
    this.mutations = null;
    this.intersection = null;
    this.clearTimers();

    let restored = 0;
    for (const [node, record] of this.records) {
      // Text the page replaced after it was translated is the page's own.
      if (node.data === record.applied) {
        node.data = record.original;
        restored += 1;
      }
    }
    this.records.clear();
    this.containers.clear();
    this.unnoticed.clear();
    this.work.clear();
    this.queue = [];
    this.pendingWrites = [];
    this.scanners = [];
    this.addedRoots.clear();
    this.inflight = 0;
    this.phase = "idle";
    this.message = "已恢复原文。";
    this.emit(true);
    return { restored };
  }

  toggle(): PageTranslationView {
    if (this.isActive()) {
      this.restore();
      return this.view();
    }
    return this.start();
  }

  /** Called from the user's click while Chrome waits for one. */
  async activate(): Promise<void> {
    const channel = this.channel;
    if (this.phase !== "needs-activation" || !channel?.activate) {
      return;
    }
    const generation = this.generation;
    this.phase = "working";
    this.message = "";
    this.emit(true);
    const ready = await channel.activate();
    if (generation !== this.generation) {
      return;
    }
    if (!ready) {
      this.phase = "error";
      this.message = "Chrome 仍然没有启用本地翻译模型。可以在扩展设置里换一个网页翻译通道。";
      this.emit(true);
      return;
    }
    this.pump();
  }

  /** Translates again from scratch; what was already translated comes from cache. */
  retry(): PageTranslationView {
    this.restore();
    return this.start();
  }

  updateSettings(next: PublicTranslationSettings): void {
    const previous = this.settings;
    this.settings = next;
    if (!this.isActive()) {
      return;
    }
    if (!next.enabled) {
      this.restore();
      return;
    }
    if (
      previous.targetLanguage !== next.targetLanguage ||
      this.channelKeyOf(next) !== this.channelKey
    ) {
      // Every translation on the page is in the old language or from the old
      // service: the page is put back and translated again under the new one.
      this.restore();
      this.start();
    }
  }

  destroy(): void {
    this.restore();
    this.channel?.destroy();
    this.channel = null;
    this.cache.clear();
  }

  /* ------------------------------------------------------------ reading */

  private readonly onText = (text: Text, container: Element): void => {
    if (this.tallied < TALLY_SAMPLE_CHARS) {
      tallyScripts(this.tally, text.data);
      this.tallied += text.data.length;
    }
    if (this.containers.has(container)) {
      return;
    }
    this.containers.set(container, {
      status: "watching",
      perNode: false,
      units: [],
      rewrites: [],
      pending: 0,
      priority: OUT_OF_RANGE
    });
    this.unnoticed.add(container);
    this.intersection?.observe(container);
  };

  private scheduleScan(delayMs: number): void {
    if (this.scanTimer !== null) {
      return;
    }
    this.scanTimer = setTimeout(this.runScan, delayMs);
  }

  private readonly runScan = (): void => {
    this.scanTimer = null;
    const deadline = performance.now() + SCAN_SLICE_MS;
    const shouldYield = () => performance.now() >= deadline;
    while (this.scanners.length > 0) {
      if (!this.scanners[0].step(shouldYield)) {
        // Give the page the main thread back before reading on.
        this.scheduleScan(0);
        return;
      }
      this.scanners.shift();
    }
    this.settleIfIdle();
  };

  private languageContext(): PageLanguageContext {
    return pageLanguageContext({
      langAttribute: this.options.langAttribute(),
      tally: this.tally
    });
  }

  /* ---------------------------------------------------------- planning */

  private readonly onIntersect = (entries: IntersectionObserverEntry[]): void => {
    const viewport = typeof window === "undefined" ? 0 : window.innerHeight;
    for (const entry of entries) {
      const container = entry.target;
      this.unnoticed.delete(container);
      const state = this.containers.get(container);
      if (!state) {
        continue;
      }
      const rect = entry.boundingClientRect;
      // On screen first, then by distance from it.
      state.priority = !entry.isIntersecting
        ? OUT_OF_RANGE
        : rect.bottom < 0
          ? -rect.bottom
          : rect.top > viewport
            ? rect.top - viewport
            : 0;
      if (state.status === "watching" && entry.isIntersecting) {
        this.planContainer(container, state);
      }
    }
    this.flushWrites();
    this.pump();
    this.settleIfIdle();
  };

  private planContainer(container: Element, state: ContainerState): void {
    for (const unit of state.units) {
      for (const { node } of unit.nodes) {
        this.plannedNodes.delete(node);
      }
    }
    state.status = "done";
    state.units = extractUnits(container, { splitNodes: state.perNode });
    for (const unit of state.units) {
      this.planUnit(unit);
    }
    if (state.pending === 0) {
      // Nothing left to write here; watching it would only cost notifications.
      this.intersection?.unobserve(container);
    }
  }

  private planUnit(unit: PageUnit): void {
    const channel = this.channel;
    if (!channel) {
      return;
    }
    const context = this.languageContext();
    const hasTags = unit.tokens.some((token) => token.kind !== "text");
    if (channel.markup && !unit.plainOnly && hasTags) {
      const text = serializeMarkup(unit.tokens);
      const source = detectTextLanguage(text.replace(/<[^>]*>/g, " "), context);
      if (!source || source === this.target) {
        return;
      }
      if (text.length <= PAGE_MAX_ITEM_CHARS) {
        const key = `m\u0001${source}\u0001${text}`;
        this.plannedCount += 1;
        for (const { node } of unit.nodes) {
          this.plannedNodes.add(node);
        }
        const cached = this.cache.get(key);
        if (cached === undefined) {
          this.addWork(key, text, source, true, { kind: "markup", unit });
          return;
        }
        if (this.applyMarkup(unit, cached)) {
          return;
        }
      }
    }
    this.planRuns(unit, context);
  }

  /** Each stretch of text between two tags on its own. */
  private planRuns(unit: PageUnit, context: PageLanguageContext): void {
    unit.tokens.forEach((token, index) => {
      if (token.kind !== "text" || !hasLetters(token.text)) {
        return;
      }
      const text = collapseWhitespace(token.text).trim();
      if (text.length > PAGE_MAX_ITEM_CHARS) {
        return;
      }
      const source = detectTextLanguage(text, context);
      if (!source || source === this.target) {
        return;
      }
      const key = `p\u0001${source}\u0001${text}`;
      this.plannedCount += 1;
      for (const node of token.nodes) {
        this.plannedNodes.add(node);
      }
      const cached = this.cache.get(key);
      if (cached !== undefined) {
        this.applyRun(unit, index, cached);
        return;
      }
      this.addWork(key, text, source, false, { kind: "run", unit, token: index });
    });
  }

  private addWork(
    key: string,
    text: string,
    source: LanguageTag,
    markup: boolean,
    target: WorkTarget
  ): void {
    if (this.phase === "error") {
      // The channel is down; what is cached still goes on, nothing new is asked.
      return;
    }
    const state = this.containers.get(target.unit.container);
    if (state) {
      state.pending += 1;
    }
    const existing = this.work.get(key);
    if (existing) {
      existing.targets.push(target);
      return;
    }
    const item: WorkItem = { key, text, source, markup, seq: this.seq++, targets: [target] };
    this.work.set(key, item);
    this.queue.push(item);
  }

  /** How urgent an item is now: the nearest of the containers it writes into. */
  private priorityOf(item: WorkItem): number {
    let best = OUT_OF_RANGE;
    for (const target of item.targets) {
      const priority = this.containers.get(target.unit.container)?.priority ?? OUT_OF_RANGE;
      if (priority < best) {
        best = priority;
      }
    }
    return best;
  }

  /** An item finished, answered or not: its containers are that much closer to done. */
  private settleTargets(item: WorkItem): void {
    for (const target of item.targets) {
      const container = target.unit.container;
      const state = this.containers.get(container);
      if (!state) {
        continue;
      }
      state.pending = Math.max(0, state.pending - 1);
      if (state.pending === 0 && state.status === "done") {
        this.intersection?.unobserve(container);
      }
    }
  }

  /* ------------------------------------------------------- translating */

  private pump(): void {
    const channel = this.channel;
    if (!channel || (this.phase !== "working" && this.phase !== "settled")) {
      return;
    }
    while (this.inflight < channel.limits.concurrency && this.queue.length > 0) {
      const batch = this.takeBatch(channel);
      if (batch.length === 0) {
        break;
      }
      this.phase = "working";
      this.inflight += 1;
      const generation = this.generation;
      const first = batch[0];
      channel
        .translate(
          batch.map((item) => item.text),
          first.source,
          first.markup
        )
        .then(
          (results) => this.onTranslated(generation, batch, results),
          (error: unknown) => this.onFailed(generation, batch, error)
        )
        .finally(() => {
          if (generation !== this.generation) {
            return;
          }
          this.inflight -= 1;
          this.pump();
          this.settleIfIdle();
          this.emit(false);
        });
    }
    this.emit(false);
  }

  /**
   * The most urgent string and whatever else fits in the same request. Among
   * equally urgent strings the earliest goes first, which keeps a screen
   * translating top to bottom; a string whose text has scrolled out of range
   * waits behind everything that is still in range.
   */
  private takeBatch(channel: PageChannel): WorkItem[] {
    const ranked = this.queue
      .map((item) => ({ item, priority: this.priorityOf(item) }))
      .sort((left, right) => left.priority - right.priority || left.item.seq - right.item.seq);
    const first = ranked[0]?.item;
    if (!first) {
      return [];
    }
    const batch = [first];
    let chars = first.text.length;
    const rest: WorkItem[] = [];
    for (const { item } of ranked.slice(1)) {
      if (
        batch.length < channel.limits.items &&
        item.source === first.source &&
        item.markup === first.markup &&
        chars + item.text.length <= channel.limits.chars
      ) {
        batch.push(item);
        chars += item.text.length;
      } else {
        rest.push(item);
      }
    }
    this.queue = rest;
    return batch;
  }

  private onTranslated(
    generation: number,
    batch: WorkItem[],
    results: Array<string | null>
  ): void {
    if (generation !== this.generation) {
      return;
    }
    batch.forEach((item, index) => {
      this.work.delete(item.key);
      this.settleTargets(item);
      const result = results[index];
      if (typeof result !== "string" || !result.trim()) {
        return;
      }
      this.remember(item.key, result);
      for (const target of item.targets) {
        if (target.kind === "run") {
          this.applyRun(target.unit, target.token, result);
        } else if (!this.applyMarkup(target.unit, result)) {
          // The translation moved or dropped a tag: this sentence goes back
          // stretch by stretch instead.
          this.planRuns(target.unit, this.languageContext());
        }
      }
    });
    this.flushWrites();
    this.pump();
  }

  private onFailed(generation: number, batch: WorkItem[], error: unknown): void {
    if (generation !== this.generation) {
      return;
    }
    const kind = error instanceof PageChannelError ? error.kind : "transient";
    const message = error instanceof Error ? error.message : "翻译失败。";
    if (kind === "needs-activation") {
      // Nothing is lost: the strings wait in the queue for the click.
      this.queue.push(...batch);
      this.phase = "needs-activation";
      this.message = message;
      this.emit(true);
      return;
    }
    for (const item of batch) {
      this.work.delete(item.key);
      this.settleTargets(item);
    }
    if (kind === "fatal") {
      for (const item of this.queue) {
        this.work.delete(item.key);
        this.settleTargets(item);
      }
      this.queue = [];
      this.phase = "error";
      this.message = message;
      this.emit(true);
      return;
    }
    // One failed request does not stop the page; the status says what failed.
    this.message = `部分文字未能翻译：${message}`;
  }

  private remember(key: string, translation: string): void {
    this.cache.delete(key);
    this.cache.set(key, translation);
    if (this.cache.size > MAX_CACHED) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
  }

  /* ----------------------------------------------------------- writing */

  private applyRun(unit: PageUnit, tokenIndex: number, translation: string): void {
    const token = unit.tokens[tokenIndex];
    if (!token || token.kind !== "text" || token.nodes.length === 0) {
      return;
    }
    // Keep the spacing the page put around the stretch: it is what separates
    // the stretch from the link or the bold word next to it.
    const lead = /^\s/.test(token.text) ? " " : "";
    const trail = /\s$/.test(token.text) ? " " : "";
    const text = `${lead}${collapseWhitespace(translation).trim()}${trail}`;
    this.pendingWrites.push({ unit, writes: fill(token.nodes, text) });
  }

  private applyMarkup(unit: PageUnit, translation: string): boolean {
    const layout = layoutOf(unit.tokens);
    const slots = parseMarkup(translation, layout.tags);
    if (!slots || slots.length !== layout.slots.length) {
      return false;
    }
    const placed = placeSlotTexts(
      slots,
      layout.slots.map((slot) => Boolean(slot && slot.nodes.length > 0)),
      layout.tags
    );
    if (!placed) {
      return false;
    }
    const writes: Array<[Text, string]> = [];
    layout.slots.forEach((slot, index) => {
      if (slot && slot.nodes.length > 0) {
        writes.push(...fill(slot.nodes, placed[index] ?? ""));
      }
    });
    this.pendingWrites.push({ unit, writes });
    return true;
  }

  /**
   * Writes every pending translation, with the mutation observer detached so
   * the page translator does not read its own writes as the page's.
   */
  private flushWrites(): void {
    if (this.pendingWrites.length === 0) {
      return;
    }
    // Whatever the page changed before this moment is handled first: it may
    // have made some of these translations stale.
    const earlier = this.mutations?.takeRecords() ?? [];
    if (earlier.length > 0) {
      this.handleMutations(earlier);
    }
    const writes = this.pendingWrites;
    this.pendingWrites = [];
    this.detached(() => {
      for (const { unit, writes: unitWrites } of writes) {
        if (!this.isCurrent(unit)) {
          continue;
        }
        for (const [node, text] of unitWrites) {
          const record = this.records.get(node);
          if (record) {
            record.applied = text;
          } else {
            const read = unit.nodes.find((entry) => entry.node === node);
            this.records.set(node, {
              original: read ? read.data : node.data,
              applied: text,
              container: unit.container
            });
          }
          if (node.data !== text) {
            node.data = text;
          }
        }
        this.translatedCount += 1;
      }
    });
    this.emit(false);
  }

  /**
   * Whether the unit's nodes still hold what the page translator last read or
   * wrote. If the page changed one since, the translation in hand is for text
   * that is no longer there.
   */
  private isCurrent(unit: PageUnit): boolean {
    return unit.nodes.every(({ node, data }) => {
      if (!node.isConnected) {
        return false;
      }
      const record = this.records.get(node);
      return node.data === (record ? record.applied : data);
    });
  }

  private detached(write: () => void): void {
    const observer = this.mutations;
    const root = this.root;
    observer?.disconnect();
    try {
      write();
    } finally {
      if (observer && root && observer === this.mutations) {
        observer.observe(root, MUTATION_OPTIONS);
      }
    }
  }

  /* ------------------------------------------------ the page changing */

  private readonly onMutations = (mutations: MutationRecord[]): void => {
    this.handleMutations(mutations);
    this.flushWrites();
    this.pump();
    this.settleIfIdle();
  };

  private handleMutations(mutations: MutationRecord[]): void {
    const dirty = new Set<Element>();
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        const node = mutation.target as Text;
        const record = this.records.get(node);
        if (record) {
          if (node.data !== record.applied) {
            dirty.add(record.container);
          }
          continue;
        }
        this.noteChangedText(node, dirty);
        continue;
      }
      if (mutation.type !== "childList") {
        continue;
      }
      const container = blockContainerOf(mutation.target);
      if (container && this.containers.get(container)?.status === "done") {
        dirty.add(container);
      }
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1 || node.nodeType === 3) {
          this.addedRoots.add(node);
        }
      });
    }
    for (const container of dirty) {
      this.refresh(container);
    }
    if (this.addedRoots.size > 0 && this.addedTimer === null) {
      this.addedTimer = setTimeout(this.scanAdded, ADDED_CONTENT_DELAY_MS);
    }
  }

  /** A text node never written here changed: maybe new text in a translated block. */
  private noteChangedText(node: Text, dirty: Set<Element>): void {
    const container = containerOf(node);
    if (!container) {
      return;
    }
    const state = this.containers.get(container);
    if (!state) {
      this.addedRoots.add(node);
      return;
    }
    // A number ticking between translated words belongs to no translation:
    // nothing written or asked for depends on it, and nothing in it needs
    // translating. Anything else changing in a planned block re-reads it.
    if (state.status === "done" && (hasLetters(node.data) || this.plannedNodes.has(node))) {
      dirty.add(container);
    }
  }

  private readonly scanAdded = (): void => {
    this.addedTimer = null;
    const roots = [...this.addedRoots];
    this.addedRoots.clear();
    for (const root of roots) {
      if (root.isConnected && !isInsideExcluded(root)) {
        this.scanners.push(new TextScanner(root, this.onText));
      }
    }
    this.scheduleScan(0);
  };

  /**
   * The page rewrote text under a translation — a re-render, a counter, a
   * framework patching a label. Its own words are put back, the container is
   * read again, and whatever is already cached goes straight back on in the
   * same task, so the reader does not see the original flash.
   */
  private refresh(container: Element): void {
    const state = this.containers.get(container);
    if (!state || state.status !== "done") {
      return;
    }
    const now = performance.now();
    state.rewrites = state.rewrites.filter((at) => now - at < REWRITE_WINDOW_MS);
    state.rewrites.push(now);
    this.dropQueuedFor(container, state);
    this.putBack(state);
    if (!container.isConnected) {
      this.containers.delete(container);
      return;
    }
    if (state.rewrites.length > MAX_REWRITES) {
      if (!state.perNode) {
        // Most often one live value inside a sentence — a counter, a clock, a
        // price. Translated node by node, the words around it no longer share
        // a node with it, and its updates stop touching the translation.
        state.perNode = true;
        state.rewrites = [];
      } else {
        // Still rewritten: a ticker, or a script that reverts foreign
        // changes. Leaving it alone costs one untranslated line; fighting
        // over it would cost the page.
        state.status = "volatile";
        state.units = [];
        this.intersection?.unobserve(container);
        return;
      }
    }
    this.planContainer(container, state);
  }

  /**
   * Forgets strings still waiting to be sent for a container's old text: the
   * page has replaced that text, so asking for it would only cost a request.
   * Strings already sent are left to finish; their answers are checked
   * against the page before anything is written.
   */
  private dropQueuedFor(container: Element, state: ContainerState): void {
    const kept: WorkItem[] = [];
    for (const item of this.queue) {
      const before = item.targets.length;
      item.targets = item.targets.filter((target) => target.unit.container !== container);
      state.pending = Math.max(0, state.pending - (before - item.targets.length));
      if (item.targets.length > 0) {
        kept.push(item);
      } else {
        this.work.delete(item.key);
      }
    }
    this.queue = kept;
  }

  /** Writes the originals back into a container's nodes the page did not change itself. */
  private putBack(state: ContainerState): void {
    this.detached(() => {
      for (const unit of state.units) {
        for (const { node } of unit.nodes) {
          const record = this.records.get(node);
          if (!record) {
            continue;
          }
          if (node.data === record.applied) {
            node.data = record.original;
          }
          this.records.delete(node);
        }
      }
    });
  }

  private readonly prune = (): void => {
    for (const node of this.records.keys()) {
      if (!node.isConnected) {
        this.records.delete(node);
      }
    }
    for (const container of this.containers.keys()) {
      if (!container.isConnected) {
        this.intersection?.unobserve(container);
        this.containers.delete(container);
        this.unnoticed.delete(container);
      }
    }
  };

  /* ------------------------------------------------------------ status */

  private settleIfIdle(): void {
    if (
      this.phase === "working" &&
      this.scanners.length === 0 &&
      this.addedTimer === null &&
      this.unnoticed.size === 0 &&
      this.queue.length === 0 &&
      this.inflight === 0
    ) {
      this.phase = "settled";
      this.emit(true);
    }
  }

  private describe(): string {
    const target = languageLabel(this.target);
    switch (this.phase) {
      case "working":
        return this.translatedCount > 0
          ? `正在翻译为${target}…已译 ${this.translatedCount} 段`
          : `正在翻译为${target}…`;
      case "settled": {
        if (this.translatedCount > 0) {
          return `已译为${target}（${this.translatedCount} 段），滚动到的新内容会自动翻译。`;
        }
        const declared = this.languageContext().declared;
        if (this.plannedCount === 0 && declared && !["ja", "en", "zh"].includes(declared)) {
          return `这个页面的语言（${declared}）不在支持范围内：网页翻译只翻译日语、英语和中文。`;
        }
        return this.plannedCount === 0
          ? `屏幕附近没有需要翻译成${target}的文字。`
          : "翻译服务没有返回可用的译文。";
      }
      case "idle":
        return "显示原文。";
      default:
        return "";
    }
  }

  private emit(immediate: boolean): void {
    if (immediate) {
      if (this.viewTimer !== null) {
        clearTimeout(this.viewTimer);
        this.viewTimer = null;
      }
      this.options.onChange(this.view());
      return;
    }
    if (this.viewTimer !== null) {
      return;
    }
    this.viewTimer = setTimeout(() => {
      this.viewTimer = null;
      this.options.onChange(this.view());
    }, VIEW_THROTTLE_MS);
  }

  /** A start that could not begin: reported, but nothing on the page to undo. */
  private refuse(message: string): PageTranslationView {
    const view: PageTranslationView = { ...this.view(), phase: "error", message };
    this.options.onChange(view);
    return view;
  }

  private clearTimers(): void {
    for (const timer of [this.scanTimer, this.addedTimer, this.viewTimer]) {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
    if (this.pruneTimer !== null) {
      clearInterval(this.pruneTimer);
    }
    this.scanTimer = null;
    this.addedTimer = null;
    this.viewTimer = null;
    this.pruneTimer = null;
  }

  private channelFor(settings: PublicTranslationSettings): PageChannel {
    const key = this.channelKeyOf(settings);
    if (this.channel && key === this.channelKey) {
      return this.channel;
    }
    this.channel?.destroy();
    this.cache.clear();
    this.channelKey = key;
    return this.options.createChannel(settings);
  }

  /** What makes two channels give different translations of the same text. */
  private channelKeyOf(settings: PublicTranslationSettings): string {
    return [
      settings.pageTranslateChannel,
      settings.targetLanguage,
      settings.draftProvider,
      settings.draftEndpointUrl,
      settings.localMtUrl,
      settings.provider,
      settings.apiBaseUrl,
      settings.model,
      settings.webSocketUrl
    ].join("\u0001");
  }
}

/** The whole text in the first node, the rest emptied: nodes are never removed. */
function fill(nodes: Text[], text: string): Array<[Text, string]> {
  return nodes.map((node, index) => [node, index === 0 ? text : ""]);
}
