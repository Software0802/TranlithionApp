/**
 * A very small element tree for adapter tests.
 *
 * The project deliberately runs its tests without a browser environment, so
 * meeting-caption fixtures are built here instead of in jsdom. It supports
 * only what the Meet adapter actually asks a caption region for: tag, class,
 * and attribute selectors joined by commas, element children, and text.
 */

export interface FakeNodeSpec {
  tag?: string;
  className?: string;
  attributes?: Record<string, string>;
  /** Text owned by this element itself, before its children. */
  text?: string;
  children?: FakeNodeSpec[];
}

type AttributeOperator = "=" | "*=" | "^=" | "$=";

type SelectorPart =
  | { kind: "class"; value: string }
  | {
      kind: "attribute";
      name: string;
      value: string;
      operator: AttributeOperator;
      caseInsensitive: boolean;
    }
  | { kind: "tag"; value: string };

export class FakeElement {
  readonly tagName: string;
  readonly classNames: string[];
  readonly attributes: Record<string, string>;
  readonly children: FakeElement[];
  isConnected = true;

  private ownText: string;

  constructor(spec: FakeNodeSpec) {
    this.tagName = (spec.tag ?? "div").toUpperCase();
    this.classNames = (spec.className ?? "").split(/\s+/).filter(Boolean);
    this.attributes = { ...spec.attributes };
    this.ownText = spec.text ?? "";
    this.children = (spec.children ?? []).map((child) => new FakeElement(child));
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  /** Approximates rendered text: one line per element child. */
  get innerText(): string {
    if (this.children.length === 0) {
      return this.ownText;
    }
    return [this.ownText, ...this.children.map((child) => child.innerText)]
      .filter((part) => part.length > 0)
      .join("\n");
  }

  setText(text: string): void {
    this.ownText = text;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  matches(selector: string): boolean {
    return selector
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .some((compound) => this.matchesCompound(compound));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) {
        found.push(child);
      }
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }

  private matchesCompound(compound: string): boolean {
    const parts = parseCompound(compound);
    if (parts.length === 0) {
      return false;
    }
    return parts.every((part) => {
      if (part.kind === "class") {
        return this.classNames.includes(part.value);
      }
      if (part.kind === "tag") {
        return this.tagName === part.value.toUpperCase();
      }
      return matchesAttribute(this.attributes[part.name], part);
    });
  }
}

export function element(spec: FakeNodeSpec): FakeElement {
  return new FakeElement(spec);
}

/** Hands a `FakeElement` to code typed against the real DOM. */
export function asElement(fake: FakeElement): Element {
  return fake as unknown as Element;
}

function parseCompound(compound: string): SelectorPart[] {
  // Attribute form: [name], [name="v"], [name*="v"], each optionally with the
  // ` i` case-insensitive flag Meet's localized aria-labels are matched with.
  const pattern = /\.([\w-]+)|\[([\w-]+)([*^$]?=)"([^"]*)"(\s+i)?\]|([A-Za-z][\w-]*)/g;
  const parts: SelectorPart[] = [];
  for (let match = pattern.exec(compound); match; match = pattern.exec(compound)) {
    if (match[1]) {
      parts.push({ kind: "class", value: match[1] });
    } else if (match[2]) {
      parts.push({
        kind: "attribute",
        name: match[2],
        operator: match[3] as AttributeOperator,
        value: match[4] ?? "",
        caseInsensitive: Boolean(match[5])
      });
    } else if (match[6]) {
      parts.push({ kind: "tag", value: match[6] });
    }
  }
  return parts;
}

function matchesAttribute(
  actual: string | undefined,
  part: Extract<SelectorPart, { kind: "attribute" }>
): boolean {
  if (actual === undefined) {
    return false;
  }
  const value = part.caseInsensitive ? actual.toLowerCase() : actual;
  const expected = part.caseInsensitive ? part.value.toLowerCase() : part.value;
  switch (part.operator) {
    case "*=":
      return value.includes(expected);
    case "^=":
      return value.startsWith(expected);
    case "$=":
      return value.endsWith(expected);
    default:
      return value === expected;
  }
}
