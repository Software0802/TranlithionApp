import { languageLabel, type LanguageTag } from "../shared/language";
import { normalizeSelectedText } from "../shared/selection-translation";

/**
 * After the user selects text: two small buttons next to the selection,
 * 「翻译」 to read the translation right there and 「侧边栏」 to send it to
 * the side panel, where translations stay side by side with the page.
 *
 * Nothing is translated until the user picks one — a selection is often just
 * a selection — and the buttons disappear with the next click elsewhere.
 */

export interface SelectionTranslation {
  ok: boolean;
  text?: string;
  error?: string;
  /** Which service answered, for the line under the translation. */
  engineLabel?: string;
}

export interface SelectionToolbarDeps {
  /** The selection's language, or null when there is nothing to translate into the target. */
  detect: (text: string, anchor: Node) => LanguageTag | null;
  target: () => LanguageTag;
  translate: (text: string, source: LanguageTag) => Promise<SelectionTranslation>;
  /** Called synchronously from the click, which Chrome needs to open the panel. */
  showInSidePanel: (text: string, source: LanguageTag) => Promise<{ ok: boolean; error?: string }>;
}

/** Longer selections go to the side panel, not into a bubble over the page. */
const MAX_INLINE_CHARS = 5_000;

interface CurrentSelection {
  text: string;
  source: LanguageTag;
}

export class SelectionToolbar {
  private readonly host = document.createElement("div");
  private readonly shadow = this.host.attachShadow({ mode: "closed" });
  private readonly chip = document.createElement("div");
  private readonly card = document.createElement("section");
  private readonly translation = document.createElement("p");
  private readonly meta = document.createElement("p");
  private readonly cardActions = document.createElement("div");
  private current: CurrentSelection | null = null;
  private readTimer: number | null = null;
  /** Bumped per request so a slow answer for an old selection is dropped. */
  private request = 0;

  constructor(private readonly deps: SelectionToolbarDeps) {
    this.host.setAttribute("data-tranlithion-ui", "selection");
    this.host.style.cssText =
      "all:initial;position:absolute;z-index:2147483646;display:none;left:0;top:0;";
    this.chip.className = "chip";
    this.chip.setAttribute("role", "toolbar");
    this.chip.setAttribute("aria-label", "Tranlithion 划词翻译");
    this.chip.append(
      actionButton("翻译", "在这里显示译文", () => this.translateHere()),
      actionButton("侧边栏", "在侧边栏显示译文", () => this.sendToSidePanel())
    );
    this.card.className = "card";
    this.card.hidden = true;
    this.translation.className = "translation";
    this.translation.setAttribute("aria-live", "polite");
    this.meta.className = "meta";
    this.cardActions.className = "actions";
    this.card.append(this.translation, this.meta, this.cardActions);
    this.shadow.append(createStyles(), this.chip, this.card);
    document.documentElement.append(this.host);

    document.addEventListener("pointerup", this.onPointerUp, { capture: true, passive: true });
    document.addEventListener("keyup", this.onKeyUp, { capture: true, passive: true });
    document.addEventListener("pointerdown", this.onPointerDown, { capture: true, passive: true });
    document.addEventListener("keydown", this.onKeyDown, { capture: true });
    document.addEventListener("selectionchange", this.onSelectionChange, { passive: true });
    window.addEventListener("resize", this.hide, { passive: true });
  }

  destroy(): void {
    document.removeEventListener("pointerup", this.onPointerUp, { capture: true });
    document.removeEventListener("keyup", this.onKeyUp, { capture: true });
    document.removeEventListener("pointerdown", this.onPointerDown, { capture: true });
    document.removeEventListener("keydown", this.onKeyDown, { capture: true });
    document.removeEventListener("selectionchange", this.onSelectionChange);
    window.removeEventListener("resize", this.hide);
    if (this.readTimer !== null) {
      window.clearTimeout(this.readTimer);
    }
    this.host.remove();
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.isOwn(event)) {
      return;
    }
    this.scheduleRead();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    // Selections made with Shift+arrows or Ctrl/Cmd+A.
    if (event.shiftKey || event.key === "a" || event.key === "A") {
      this.scheduleRead();
    }
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.isOwn(event)) {
      this.hide();
    }
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.host.style.display !== "none") {
      this.hide();
    }
  };

  private readonly onSelectionChange = (): void => {
    // A result the reader is looking at stays until they close it.
    if (!this.card.hidden) {
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      this.hide();
    }
  };

  private readonly hide = (): void => {
    this.request += 1;
    this.current = null;
    this.card.hidden = true;
    this.host.style.display = "none";
  };

  private isOwn(event: Event): boolean {
    return event.composedPath().includes(this.host);
  }

  private scheduleRead(): void {
    if (this.readTimer !== null) {
      window.clearTimeout(this.readTimer);
    }
    // After the browser has finished extending the selection.
    this.readTimer = window.setTimeout(() => {
      this.readTimer = null;
      this.readSelection();
    }, 30);
  }

  private readSelection(): void {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }
    const text = normalizeSelectedText(selection.toString());
    const range = selection.getRangeAt(0);
    if (!text || isInsideEditableOrOwnUi(range.commonAncestorContainer)) {
      return;
    }
    const source = this.deps.detect(text, range.commonAncestorContainer);
    if (!source) {
      // Already in the target language, or nothing a translator could change.
      return;
    }
    if (this.current?.text === text && this.host.style.display !== "none") {
      return;
    }
    const rects = range.getClientRects();
    const anchor = rects.length > 0 ? rects[rects.length - 1] : range.getBoundingClientRect();
    if (anchor.width === 0 && anchor.height === 0) {
      return;
    }
    this.request += 1;
    this.current = { text, source };
    this.card.hidden = true;
    this.placeAt(anchor);
    this.host.style.display = "block";
  }

  private placeAt(rect: DOMRect): void {
    const width = Math.min(360, window.innerWidth - 24);
    const left = Math.min(
      Math.max(8, rect.right - 40),
      Math.max(8, window.innerWidth - width - 12)
    );
    this.host.style.left = `${Math.round(left + window.scrollX)}px`;
    this.host.style.top = `${Math.round(rect.bottom + window.scrollY + 6)}px`;
  }

  private translateHere(): void {
    const current = this.current;
    if (!current) {
      return;
    }
    if (current.text.length > MAX_INLINE_CHARS) {
      this.showCard(`选中的文字超过 ${MAX_INLINE_CHARS} 字，请分段选择。`, "", current, false);
      return;
    }
    const request = ++this.request;
    this.showCard("正在翻译…", this.pairLabel(current), current, false);
    void this.deps.translate(current.text, current.source).then(
      (result) => {
        if (request !== this.request) {
          return;
        }
        if (!result.ok || !result.text) {
          this.showCard(result.error ?? "翻译失败。", this.pairLabel(current), current, false);
          return;
        }
        const meta = [this.pairLabel(current), result.engineLabel].filter(Boolean).join(" · ");
        this.showCard(result.text, meta, current, true);
      },
      () => {
        if (request === this.request) {
          this.showCard("翻译失败。", this.pairLabel(current), current, false);
        }
      }
    );
  }

  private sendToSidePanel(): void {
    const current = this.current;
    if (!current) {
      return;
    }
    // Sent before anything else happens: the click is what lets Chrome open the panel.
    const sent = this.deps.showInSidePanel(current.text, current.source);
    const request = ++this.request;
    void sent.then(
      (result) => {
        if (request !== this.request) {
          return;
        }
        if (result.ok) {
          this.hide();
          return;
        }
        this.showCard(result.error ?? "无法打开侧边栏。", "", current, false);
      },
      () => {
        if (request === this.request) {
          this.showCard("无法打开侧边栏。", "", current, false);
        }
      }
    );
  }

  private showCard(
    text: string,
    meta: string,
    current: CurrentSelection,
    translated: boolean
  ): void {
    this.translation.textContent = text;
    this.translation.dataset.state = translated ? "done" : "note";
    this.meta.textContent = meta;
    this.meta.hidden = !meta;
    const actions: HTMLButtonElement[] = [];
    if (translated) {
      const copy = actionButton("复制", "复制译文", () => {
        void navigator.clipboard.writeText(text).then(
          () => {
            copy.textContent = "已复制";
          },
          () => {
            copy.textContent = "复制失败";
          }
        );
      });
      actions.push(copy);
    }
    actions.push(
      actionButton("侧边栏", "在侧边栏显示译文", () => {
        this.current = current;
        this.sendToSidePanel();
      }),
      actionButton("关闭", "关闭译文", () => this.hide())
    );
    this.cardActions.replaceChildren(...actions);
    this.card.hidden = false;
  }

  private pairLabel(current: CurrentSelection): string {
    return `${languageLabel(current.source)} → ${languageLabel(this.deps.target())}`;
  }
}

function actionButton(text: string, label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.title = label;
  element.setAttribute("aria-label", label);
  // Keeps the page's selection: pressing a button would otherwise clear it.
  element.addEventListener("pointerdown", (event) => event.preventDefault());
  element.addEventListener("mousedown", (event) => event.preventDefault());
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return element;
}

/** Text the user is editing, or the extension's own UI: no buttons there. */
function isInsideEditableOrOwnUi(node: Node): boolean {
  let current: Node | null = node;
  while (current) {
    if (current.nodeType === 1) {
      const element = current as Element;
      const tag = element.tagName.toUpperCase();
      const editable = element.getAttribute("contenteditable");
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (editable !== null && editable.toLowerCase() !== "false") ||
        element.getAttribute("data-tranlithion-ui") !== null ||
        element.getAttribute("data-tranlithion-overlay") !== null
      ) {
        return true;
      }
    }
    current = current.parentNode;
  }
  return false;
}

function createStyles(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .chip, .card {
      box-sizing: border-box;
      border: 1px solid oklch(0.36 0.015 110);
      background: oklch(0.17 0.008 110 / 0.97);
      color: oklch(0.96 0.006 110);
      box-shadow: 0 8px 24px oklch(0 0 0 / 0.28);
      font: 13px/1.45 Inter, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    }
    .chip {
      display: inline-flex;
      gap: 2px;
      padding: 3px;
      border-radius: 9px;
    }
    .card {
      width: min(360px, calc(100vw - 24px));
      margin-top: 6px;
      padding: 10px 12px 8px;
      border-radius: 10px;
    }
    .card[hidden], .meta[hidden] { display: none; }
    .translation {
      margin: 0;
      font-size: 14px;
      line-height: 1.6;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 40vh;
      overflow: auto;
      user-select: text;
    }
    .translation[data-state="note"] { color: oklch(0.8 0.02 110); }
    .meta { margin: 6px 0 0; color: oklch(0.7 0.018 110); font-size: 12px; }
    .actions { display: flex; justify-content: flex-end; gap: 2px; margin-top: 6px; }
    button {
      all: unset;
      box-sizing: border-box;
      min-height: 26px;
      padding: 3px 9px;
      border-radius: 6px;
      color: oklch(0.88 0.1 110);
      font: 600 12.5px/1.3 Inter, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover { background: oklch(0.26 0.012 110); }
    button:focus-visible { outline: 2px solid oklch(0.72 0.14 110); outline-offset: 2px; }
  `;
  return style;
}
