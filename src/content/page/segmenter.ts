import { hasLetters } from "../../shared/page-translation";
import type { UnitToken } from "./markup";

/**
 * Reads a page into translation units without changing it.
 *
 * A *container* is the nearest block-level element around some text: a
 * paragraph, a list item, a button, a table cell. Everything inline inside it —
 * text, links, bold words — up to the next nested block is one *unit*, which is
 * what gets translated as a whole. The page translator only ever writes the
 * `data` of the text nodes a unit found; it never creates, moves, wraps or
 * removes a node. Frameworks such as React keep references to exactly those
 * nodes, and rearranging them — as Chrome's own page translation does by
 * wrapping text in `<font>` — is what makes such pages throw and go blank.
 */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** Elements whose text is part of the sentence around them. */
const INLINE_TAGS = new Set([
  "A", "ABBR", "ACRONYM", "B", "BDI", "BDO", "BIG", "CITE", "DATA", "DEL", "DFN", "EM",
  "FONT", "I", "INS", "LABEL", "MARK", "NOBR", "Q", "RB", "RUBY", "S", "SMALL", "SPAN",
  "STRIKE", "STRONG", "SUB", "SUP", "TIME", "TT", "U"
]);

/** Never page text: not rendered, or not prose. */
const IGNORED_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE", "META", "LINK", "WBR",
  // Ruby readings belong to the characters they annotate, not to the sentence.
  "RT", "RP"
]);

/**
 * Inline content that stays exactly as it is: code, form controls, media.
 * A form control's text can be its submitted value, and code translated into
 * another language is no longer the code.
 */
const OPAQUE_INLINE_TAGS = new Set([
  "CODE", "KBD", "SAMP", "VAR", "IMG", "SVG", "MATH", "INPUT", "SELECT", "OPTION",
  "OPTGROUP", "DATALIST", "TEXTAREA", "CANVAS", "VIDEO", "AUDIO", "IFRAME", "OBJECT",
  "EMBED", "PICTURE", "BR", "OUTPUT", "METER", "PROGRESS"
]);

/** Block content that stays exactly as it is. */
const OPAQUE_BLOCK_TAGS = new Set(["PRE", "LISTING", "XMP", "PLAINTEXT"]);

type Role = "ignored" | "void" | "opaque-block" | "inline" | "block";

/**
 * Regions the page translator leaves alone even though they hold text:
 * captions the subtitle adapters read (translating them would feed the
 * adapters their own translation) and the extension's own UI.
 */
function isCaptionOrOwnUi(element: Element): boolean {
  if (
    element.getAttribute("data-tranlithion-overlay") !== null ||
    element.getAttribute("data-tranlithion-ui") !== null ||
    element.getAttribute("data-tranlithion-meet-captions") !== null
  ) {
    return true;
  }
  const uia = element.getAttribute("data-uia");
  if (uia === "player-subtitle-text" || uia === "player-timedtext") {
    return true;
  }
  const classes = element.getAttribute("class");
  return Boolean(
    classes &&
      /(?:^|\s)(?:ytp-caption-window-container|caption-window|player-timedtext)(?:\s|$)/.test(classes)
  );
}

/**
 * The page asked for this not to be translated (`translate="no"`, Google's
 * `notranslate` class), or it is text the user is editing: changing an
 * editor's text would change the user's document, and saving it would keep
 * the translation.
 */
function isOptedOut(element: Element): boolean {
  if (element.getAttribute("translate") === "no") {
    return true;
  }
  const editable = element.getAttribute("contenteditable");
  if (editable !== null && editable.toLowerCase() !== "false") {
    return true;
  }
  const classes = element.getAttribute("class");
  if (classes && /(?:^|\s)notranslate(?:\s|$)/.test(classes)) {
    return true;
  }
  return isCaptionOrOwnUi(element);
}

function roleOf(element: Element): Role {
  const tag = element.tagName.toUpperCase();
  if (IGNORED_TAGS.has(tag)) {
    return "ignored";
  }
  const inlineish = INLINE_TAGS.has(tag) || OPAQUE_INLINE_TAGS.has(tag);
  if (OPAQUE_INLINE_TAGS.has(tag) || isOptedOut(element)) {
    return inlineish ? "void" : "opaque-block";
  }
  if (OPAQUE_BLOCK_TAGS.has(tag)) {
    return "opaque-block";
  }
  return INLINE_TAGS.has(tag) ? "inline" : "block";
}

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE;
}

function isText(node: Node): node is Text {
  return node.nodeType === TEXT_NODE;
}

/** The block-level element whose unit a text node belongs to. */
export function containerOf(node: Node): Element | null {
  let current: Node | null = node.parentNode;
  while (current && isElement(current)) {
    if (roleOf(current) !== "inline") {
      return current;
    }
    const parent: Node | null = current.parentNode;
    if (!parent || !isElement(parent)) {
      return current;
    }
    current = parent;
  }
  return null;
}

/**
 * The container whose units a change to `node`'s children affects: the node
 * itself when it is a block, otherwise the block around it. Null inside
 * content that is never translated.
 */
export function blockContainerOf(node: Node): Element | null {
  if (isElement(node)) {
    const role = roleOf(node);
    if (role === "block") {
      return node;
    }
    if (role !== "inline") {
      return null;
    }
  }
  return containerOf(node);
}

/**
 * Whether a node sits somewhere the page translator must not write: inside
 * code, a form control, an editor, a caption region, or a subtree the page
 * marked as not to be translated. Used for nodes that turn up after the
 * first scan, whose ancestors were never walked.
 */
export function isInsideExcluded(node: Node): boolean {
  let current: Node | null = node.nodeType === ELEMENT_NODE ? node : node.parentNode;
  while (current && isElement(current)) {
    const role = roleOf(current);
    if (role === "ignored" || role === "void" || role === "opaque-block") {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}

/**
 * Walks a subtree for text in time slices, reporting each text node that has
 * letters together with its container. A huge page is walked a few
 * milliseconds at a time, so the page never stops responding while it is
 * read.
 */
export class TextScanner {
  private cursor: Node | null;

  constructor(
    private readonly root: Node,
    private readonly onText: (text: Text, container: Element) => void
  ) {
    this.cursor = isText(root) ? root : root.firstChild;
  }

  /** Walks until `shouldYield` says stop. Returns true once the subtree is done. */
  step(shouldYield: () => boolean): boolean {
    let node = this.cursor;
    let visited = 0;
    while (node) {
      visited += 1;
      if (visited % 64 === 0 && shouldYield()) {
        this.cursor = node;
        return false;
      }
      let descend = false;
      if (isElement(node)) {
        const role = roleOf(node);
        descend = role === "inline" || role === "block";
      } else if (isText(node) && hasLetters(node.data)) {
        const container = containerOf(node);
        if (container) {
          this.onText(node, container);
        }
      }
      node = descend && node.firstChild ? node.firstChild : this.nextOutside(node);
    }
    this.cursor = null;
    return true;
  }

  private nextOutside(node: Node): Node | null {
    let current: Node | null = node;
    while (current && current !== this.root) {
      if (current.nextSibling) {
        return current.nextSibling;
      }
      current = current.parentNode;
    }
    return null;
  }
}

/** One text node of a unit and the text it held when the unit was read. */
export interface UnitNode {
  node: Text;
  data: string;
}

export interface PageUnit {
  container: Element;
  tokens: UnitToken<Text>[];
  nodes: UnitNode[];
  /**
   * A block interrupts an inline element here, so the unit's tags do not
   * balance; it is translated run by run rather than as marked-up text.
   */
  plainOnly: boolean;
}

/** More tags than this and the marked-up sentence is not worth the risk. */
const MAX_UNIT_TAGS = 60;
const MAX_UNIT_CHARS = 4_000;

/**
 * Cuts a container's inline content into units, reading the text as it is
 * now. Nested blocks are their own containers and are left to their own
 * units; so is anything opaque or opted out, which becomes a void tag so a
 * translation can still say where the sentence goes around it.
 *
 * `splitNodes` keeps every text node a stretch of its own instead of joining
 * adjacent ones — for a sentence with a live value in it (`{count} 件`),
 * where the page rewrites one node and must not disturb the others.
 */
export function extractUnits(
  container: Element,
  options: { splitNodes?: boolean } = {}
): PageUnit[] {
  const units: PageUnit[] = [];
  let tokens: UnitToken<Text>[] = [];
  let nodes: UnitNode[] = [];
  let plainOnly = false;
  let nextId = 0;
  let depth = 0;
  /** Bumped on every flush so an inline element can tell it was split. */
  let generation = 0;

  const flush = () => {
    const hasText = tokens.some((token) => token.kind === "text" && hasLetters(token.text));
    if (hasText) {
      const tagCount = tokens.filter((token) => token.kind !== "text").length;
      const chars = nodes.reduce((total, entry) => total + entry.data.length, 0);
      units.push({
        container,
        tokens,
        nodes,
        plainOnly:
          plainOnly || Boolean(options.splitNodes) || tagCount > MAX_UNIT_TAGS || chars > MAX_UNIT_CHARS
      });
    }
    tokens = [];
    nodes = [];
    nextId = 0;
    generation += 1;
    // A unit that starts inside an inline element opened in the last one
    // closes a tag it never opened.
    plainOnly = depth > 0;
  };

  const visit = (parent: Node) => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (isText(child)) {
        const data = child.data;
        nodes.push({ node: child, data });
        const last = tokens[tokens.length - 1];
        if (last?.kind === "text" && !options.splitNodes) {
          last.nodes.push(child);
          last.text += data;
        } else {
          tokens.push({ kind: "text", nodes: [child], text: data });
        }
        continue;
      }
      if (!isElement(child)) {
        continue;
      }
      const role = roleOf(child);
      if (role === "ignored") {
        continue;
      }
      if (role === "void") {
        tokens.push({ kind: "void", id: nextId++ });
        continue;
      }
      if (role === "block" || role === "opaque-block") {
        if (depth > 0) {
          plainOnly = true;
        }
        flush();
        continue;
      }
      const id = nextId++;
      const start = tokens.length;
      const startGeneration = generation;
      tokens.push({ kind: "open", id });
      depth += 1;
      visit(child);
      depth -= 1;
      tokens.push({ kind: "close", id });
      if (generation === startGeneration && !tokens.slice(start).some((token) => token.kind === "text")) {
        // An element with no text of its own — an icon, an empty span — is
        // only a position in the sentence.
        tokens.splice(start, tokens.length - start, { kind: "void", id });
      }
    }
  };

  visit(container);
  flush();
  return units;
}
