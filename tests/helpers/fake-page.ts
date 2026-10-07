/**
 * A small page for the page translator's tests: elements and text nodes with
 * parent links, attribute reads, and working mutation and intersection
 * observers.
 *
 * The one thing the page translator promises above all is that it never
 * changes the page's structure — it only writes text into nodes that are
 * already there. So every structural method here throws unless the test says
 * the *page* is making the change (`page.mutate`). If the translator ever
 * inserted, moved or removed a node, the test would fail on the spot.
 */

type MutationListener = {
  observer: FakeMutationObserver;
  target: FakeNode;
  options: MutationObserverInit;
};

let pageIsMutating = 0;
const mutationListeners: MutationListener[] = [];
/** Every `data` write, in order: who wrote what where. */
export const dataWrites: Array<{ node: FakeText; data: string; byPage: boolean }> = [];

export abstract class FakeNode {
  abstract readonly nodeType: number;
  parentNode: FakeElement | null = null;
  /** Set on the document root; everything under it is connected. */
  rootConnected = false;

  get isConnected(): boolean {
    let node: FakeNode | null = this;
    while (node) {
      if (node.rootConnected) {
        return true;
      }
      node = node.parentNode;
    }
    return false;
  }

  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes;
    if (!siblings) {
      return null;
    }
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  get previousSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes;
    if (!siblings) {
      return null;
    }
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }

  get firstChild(): FakeNode | null {
    return null;
  }

  isInside(ancestor: FakeNode): boolean {
    let node: FakeNode | null = this;
    while (node) {
      if (node === ancestor) {
        return true;
      }
      node = node.parentNode;
    }
    return false;
  }
}

export class FakeText extends FakeNode {
  readonly nodeType = 3;
  private value: string;

  constructor(data: string) {
    super();
    this.value = data;
  }

  get data(): string {
    return this.value;
  }

  set data(next: string) {
    if (next === this.value) {
      return;
    }
    this.value = next;
    dataWrites.push({ node: this, data: next, byPage: pageIsMutating > 0 });
    queueMutation(this, { type: "characterData", target: this, addedNodes: [], removedNodes: [] });
  }

  get nodeValue(): string {
    return this.value;
  }

  get textContent(): string {
    return this.value;
  }
}

export class FakeElement extends FakeNode {
  readonly nodeType = 1;
  readonly tagName: string;
  readonly childNodes: FakeNode[] = [];
  private readonly attributes = new Map<string, string>();

  constructor(tag: string, attributes: Record<string, string> = {}) {
    super();
    this.tagName = tag.toUpperCase();
    for (const [name, value] of Object.entries(attributes)) {
      this.attributes.set(name, value);
    }
  }

  override get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get textContent(): string {
    return this.childNodes
      .map((child) => (child instanceof FakeText ? child.data : (child as FakeElement).textContent))
      .join("");
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  appendChild(node: FakeNode): FakeNode {
    return this.insertBefore(node, null);
  }

  insertBefore(node: FakeNode, reference: FakeNode | null): FakeNode {
    assertPageMutation("insertBefore/appendChild");
    node.parentNode?.detach(node);
    const index = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
    this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, node);
    node.parentNode = this;
    queueMutation(this, { type: "childList", target: this, addedNodes: [node], removedNodes: [] });
    return node;
  }

  removeChild(node: FakeNode): FakeNode {
    assertPageMutation("removeChild");
    this.detach(node);
    queueMutation(this, { type: "childList", target: this, addedNodes: [], removedNodes: [node] });
    return node;
  }

  replaceChild(next: FakeNode, previous: FakeNode): FakeNode {
    assertPageMutation("replaceChild");
    const index = this.childNodes.indexOf(previous);
    next.parentNode?.detach(next);
    this.childNodes.splice(index, 1, next);
    previous.parentNode = null;
    next.parentNode = this;
    queueMutation(this, {
      type: "childList",
      target: this,
      addedNodes: [next],
      removedNodes: [previous]
    });
    return previous;
  }

  /** Internal: unlinks a child without recording anything. */
  detach(node: FakeNode): void {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) {
      this.childNodes.splice(index, 1);
    }
    node.parentNode = null;
  }

  /** All text nodes below, in document order. */
  texts(): FakeText[] {
    return this.childNodes.flatMap((child) =>
      child instanceof FakeText ? [child] : (child as FakeElement).texts()
    );
  }

  /** Every node below, in document order: used to prove the structure never changed. */
  shape(): FakeNode[] {
    return this.childNodes.flatMap((child) =>
      child instanceof FakeElement ? [child, ...child.shape()] : [child]
    );
  }
}

type Child = FakeNode | string;

/** `h("p", {class: "x"}, "Hello ", h("a", {}, "world"))` */
export function h(
  tag: string,
  attributes: Record<string, string> = {},
  ...children: Child[]
): FakeElement {
  const element = new FakeElement(tag, attributes);
  for (const child of children) {
    const node = typeof child === "string" ? new FakeText(child) : child;
    element.childNodes.push(node);
    node.parentNode = element;
  }
  return element;
}

export function text(data: string): FakeText {
  return new FakeText(data);
}

function assertPageMutation(method: string): void {
  if (pageIsMutating === 0) {
    throw new Error(`The page translator called ${method}: it must never change the page's structure.`);
  }
}

/** Runs a change as the page itself would make it. */
export function mutate(change: () => void): void {
  pageIsMutating += 1;
  try {
    change();
  } finally {
    pageIsMutating -= 1;
  }
}

interface FakeRecord {
  type: "characterData" | "childList";
  target: FakeNode;
  addedNodes: FakeNode[];
  removedNodes: FakeNode[];
}

function queueMutation(node: FakeNode, record: FakeRecord): void {
  for (const listener of mutationListeners) {
    const { options, target, observer } = listener;
    const watched =
      node === target || (options.subtree === true && node.isInside(target));
    if (!watched) {
      continue;
    }
    if (record.type === "characterData" && !options.characterData) {
      continue;
    }
    if (record.type === "childList" && !options.childList) {
      continue;
    }
    observer.enqueue(record);
  }
}

export class FakeMutationObserver {
  private pending: FakeRecord[] = [];
  private scheduled = false;

  constructor(private readonly callback: (records: FakeRecord[], observer: unknown) => void) {}

  observe(target: FakeNode, options: MutationObserverInit): void {
    mutationListeners.push({ observer: this, target, options });
  }

  disconnect(): void {
    for (let index = mutationListeners.length - 1; index >= 0; index -= 1) {
      if (mutationListeners[index].observer === this) {
        mutationListeners.splice(index, 1);
      }
    }
    this.pending = [];
  }

  takeRecords(): FakeRecord[] {
    const records = this.pending;
    this.pending = [];
    return records;
  }

  enqueue(record: FakeRecord): void {
    this.pending.push(record);
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    // Mutation observers are called in a microtask, after the change that
    // caused them and before anything else the page schedules.
    void Promise.resolve().then(() => {
      this.scheduled = false;
      const records = this.takeRecords();
      if (records.length > 0) {
        this.callback(records, this);
      }
    });
  }
}

export interface Placement {
  /** Top edge relative to the viewport, in px. */
  top: number;
  height?: number;
  /** Outside the observer's margin altogether. */
  outOfRange?: boolean;
}

/** Intersection observers the tests drive by hand: they say where things are. */
export class FakeIntersectionObserver {
  static readonly instances: FakeIntersectionObserver[] = [];
  readonly observed = new Set<FakeElement>();
  /** Observed elements that have not had their first notification yet. */
  private readonly fresh = new Set<FakeElement>();
  disconnected = false;

  constructor(
    private readonly callback: (entries: unknown[], observer: unknown) => void,
    readonly options: IntersectionObserverInit = {}
  ) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(target: FakeElement): void {
    if (!this.observed.has(target)) {
      this.observed.add(target);
      this.fresh.add(target);
    }
  }

  unobserve(target: FakeElement): void {
    this.observed.delete(target);
    this.fresh.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
    this.fresh.clear();
    this.disconnected = true;
  }

  /**
   * Delivers the first notification for everything observed since the last
   * call, as the browser does after `observe`. `place` says where an element
   * is; anything it does not place is out of range.
   */
  notice(place: (element: FakeElement) => Placement | null): void {
    const targets = [...this.fresh];
    this.fresh.clear();
    this.deliver(targets, place);
  }

  /** The reader scrolled: notifies the given elements with their new places. */
  move(targets: FakeElement[], place: (element: FakeElement) => Placement | null): void {
    this.deliver(
      targets.filter((target) => this.observed.has(target)),
      place
    );
  }

  private deliver(targets: FakeElement[], place: (element: FakeElement) => Placement | null): void {
    if (targets.length === 0 || this.disconnected) {
      return;
    }
    const entries = targets.map((target) => {
      const placement = place(target);
      const top = placement?.top ?? 100_000;
      const height = placement?.height ?? 20;
      return {
        target,
        isIntersecting: Boolean(placement) && !placement?.outOfRange,
        boundingClientRect: { top, bottom: top + height, height, left: 0, right: 100, width: 100 }
      };
    });
    this.callback(entries, this);
  }
}

/** Installs the fakes as the globals the page translator uses. */
export function installFakePage(body: FakeElement, options: { lang?: string } = {}) {
  const html = h("html", options.lang ? { lang: options.lang } : {}, body);
  html.rootConnected = true;
  FakeIntersectionObserver.instances.length = 0;
  mutationListeners.length = 0;
  dataWrites.length = 0;
  return {
    html,
    body,
    get intersection(): FakeIntersectionObserver {
      const live = FakeIntersectionObserver.instances.filter((instance) => !instance.disconnected);
      const current = live[live.length - 1];
      if (!current) {
        throw new Error("no intersection observer is active");
      }
      return current;
    },
    globals: {
      MutationObserver: FakeMutationObserver,
      IntersectionObserver: FakeIntersectionObserver,
      window: { innerHeight: 800 }
    }
  };
}

export function asElement(node: FakeElement): Element {
  return node as unknown as Element;
}
