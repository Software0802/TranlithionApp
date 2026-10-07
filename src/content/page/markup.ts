/**
 * Placeholder markup for translating a sentence that the page split across
 * inline elements.
 *
 * `詳しくは<a>こちら</a>をご覧ください` is one sentence in three text nodes.
 * Translated node by node it reads as three fragments; translated as one
 * string it has nowhere to go but a single node, which would empty the link.
 * Instead the sentence is sent as `詳しくは<t0>こちら</t0>をご覧ください`, and
 * when the translation keeps the tags in the same order, the text between
 * them goes back into the page's own nodes — the link keeps its text, and no
 * node is created, moved or removed.
 *
 * Nothing here touches the DOM: the node type is a parameter.
 */

export type UnitToken<N> =
  /** A run of adjacent text nodes with no element between them. */
  | { kind: "text"; nodes: N[]; text: string }
  | { kind: "open"; id: number }
  | { kind: "close"; id: number }
  /** An element that holds no text to translate: `<br>`, an icon, inline code. */
  | { kind: "void"; id: number };

export type TagToken = Exclude<UnitToken<unknown>, { kind: "text" }>;

export interface MarkupLayout<N> {
  tags: TagToken[];
  /**
   * The text between consecutive tags: slot 0 before the first tag, slot i
   * after tag i-1. A slot without nodes had no text in the page.
   */
  slots: Array<{ nodes: N[]; text: string } | null>;
}

export function layoutOf<N>(tokens: UnitToken<N>[]): MarkupLayout<N> {
  const tags: TagToken[] = [];
  const slots: MarkupLayout<N>["slots"] = [null];
  for (const token of tokens) {
    if (token.kind === "text") {
      const current = slots[slots.length - 1];
      slots[slots.length - 1] = current
        ? { nodes: [...current.nodes, ...token.nodes], text: current.text + token.text }
        : { nodes: [...token.nodes], text: token.text };
      continue;
    }
    tags.push(token);
    slots.push(null);
  }
  return { tags, slots };
}

export function serializeMarkup<N>(tokens: UnitToken<N>[]): string {
  return tokens
    .map((token) => {
      switch (token.kind) {
        case "text":
          return escapeMarkupText(collapseWhitespace(token.text));
        case "open":
          return `<t${token.id}>`;
        case "close":
          return `</t${token.id}>`;
        case "void":
          return `<x${token.id}/>`;
      }
    })
    .join("")
    .trim();
}

const TAG_PATTERN = /<\s*(\/)?\s*([tx])\s*(\d+)\s*(\/)?\s*>/gi;

/**
 * The translated text of each slot, or null when the translation did not keep
 * the tags — dropped, added, or reordered ones — and so cannot be put back
 * into the page's nodes without moving them.
 */
export function parseMarkup(translated: string, tags: TagToken[]): string[] | null {
  const found: TagToken[] = [];
  const texts: string[] = [];
  let cursor = 0;
  /** Text of the slot after the last tag found so far. */
  let current = "";
  const pattern = new RegExp(TAG_PATTERN.source, TAG_PATTERN.flags);
  for (let match = pattern.exec(translated); match; match = pattern.exec(translated)) {
    const closing = Boolean(match[1]);
    const letter = match[2].toLowerCase();
    const id = Number(match[3]);
    const selfClosing = Boolean(match[4]);
    current += translated.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    let tag: TagToken;
    if (letter === "x") {
      if (closing) {
        // A void placeholder answered as `<x0></x0>` is still one element;
        // its closing half carries nothing.
        continue;
      }
      tag = { kind: "void", id };
    } else if (selfClosing) {
      return null;
    } else {
      tag = closing ? { kind: "close", id } : { kind: "open", id };
    }
    texts.push(current);
    current = "";
    found.push(tag);
  }
  texts.push(current + translated.slice(cursor));

  if (found.length !== tags.length) {
    return null;
  }
  for (let index = 0; index < tags.length; index += 1) {
    const expected = tags[index];
    const actual = found[index];
    if (!actual || expected.kind !== actual.kind || expected.id !== actual.id) {
      return null;
    }
  }

  const slots = texts.map((text) => collapseWhitespace(unescapeMarkupText(text)));
  slots[0] = slots[0].trimStart();
  slots[slots.length - 1] = slots[slots.length - 1].trimEnd();
  return slots;
}

/**
 * Fits translated slot texts onto the slots that have nodes to hold them.
 *
 * A translation may put words where the page had none — before an icon, say,
 * rather than after it. Text is moved across void elements to the nearest
 * slot that has a node, since that only changes which side of an icon or a
 * line break it sits on. It is never moved across an element's opening or
 * closing tag: that would put words inside or outside a link that the
 * translation did not. Returns null when some text has nowhere to go.
 */
export function placeSlotTexts(
  slotTexts: string[],
  hasNodes: boolean[],
  tags: TagToken[]
): string[] | null {
  const placed = slotTexts.map((text, index) => (hasNodes[index] ? text : ""));
  for (let index = 0; index < slotTexts.length; index += 1) {
    const text = slotTexts[index];
    if (hasNodes[index] || text.trim() === "") {
      continue;
    }
    const before = nearestHolder(index, -1, hasNodes, tags);
    const after = nearestHolder(index, 1, hasNodes, tags);
    if (before !== null) {
      placed[before] = `${placed[before]}${text}`;
    } else if (after !== null) {
      placed[after] = `${text}${placed[after]}`;
    } else {
      return null;
    }
  }
  return placed;
}

function nearestHolder(
  from: number,
  step: -1 | 1,
  hasNodes: boolean[],
  tags: TagToken[]
): number | null {
  for (let slot = from + step; slot >= 0 && slot < hasNodes.length; slot += step) {
    // Slots `slot` and `slot - step` are separated by tag min(slot, slot - step).
    const between = tags[Math.min(slot, slot - step)];
    if (!between || between.kind !== "void") {
      return null;
    }
    if (hasNodes[slot]) {
      return slot;
    }
  }
  return null;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

export function escapeMarkupText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function unescapeMarkupText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos|nbsp);/gi, (entity, body: string) => {
    const name = body.toLowerCase();
    if (name.startsWith("#x")) {
      return safeCodePoint(Number.parseInt(name.slice(2), 16), entity);
    }
    if (name.startsWith("#")) {
      return safeCodePoint(Number.parseInt(name.slice(1), 10), entity);
    }
    switch (name) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      case "nbsp":
        return " ";
      default:
        return entity;
    }
  });
}

function safeCodePoint(value: number, fallback: string): string {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : fallback;
}
