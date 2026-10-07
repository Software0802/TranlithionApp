import type { PageTranslationView } from "./page-translator";

/**
 * The small status line a page shows while it is translated: what is
 * happening, and the one action that makes sense right now. It stays out of
 * the way — a corner, a sentence, no animation — and goes away on its own
 * once the page is translated; the toolbar badge keeps saying so after that.
 */

export interface PageStatusActions {
  restore: () => void;
  retry: () => void;
  /** Must run inside the click: Chrome wants the activation that comes with it. */
  activate: () => void;
}

const SETTLED_HIDE_MS = 5_000;
const RESTORED_HIDE_MS = 2_000;

export class PageStatusPill {
  private readonly host = document.createElement("div");
  private readonly shadow = this.host.attachShadow({ mode: "closed" });
  private readonly bar = document.createElement("div");
  private readonly label = document.createElement("p");
  private readonly buttons = document.createElement("div");
  private hideTimer: number | null = null;
  private hovered = false;
  /** The phase the user closed the line in; it stays closed until that changes. */
  private dismissedIn: PageTranslationView["phase"] | null = null;
  private lastPhase: PageTranslationView["phase"] | null = null;

  constructor(private readonly actions: PageStatusActions) {
    this.host.setAttribute("data-tranlithion-ui", "page-status");
    this.host.style.cssText =
      "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483646;display:none;";
    this.bar.className = "bar";
    this.label.className = "label";
    this.label.setAttribute("role", "status");
    this.label.setAttribute("aria-live", "polite");
    this.buttons.className = "buttons";
    this.bar.append(this.label, this.buttons);
    this.shadow.append(createStyles(), this.bar);
    this.bar.addEventListener("pointerenter", () => {
      this.hovered = true;
      this.clearHideTimer();
    });
    this.bar.addEventListener("pointerleave", () => {
      this.hovered = false;
    });
    document.documentElement.append(this.host);
  }

  render(view: PageTranslationView): void {
    if (view.phase !== this.lastPhase) {
      this.dismissedIn = null;
      this.lastPhase = view.phase;
    }
    if (this.dismissedIn === view.phase) {
      return;
    }
    this.clearHideTimer();
    this.bar.dataset.tone = view.phase;
    this.label.textContent = labelFor(view);
    this.buttons.replaceChildren(...this.buttonsFor(view));
    this.host.style.display = "block";
    if (view.phase === "settled") {
      this.hideLater(SETTLED_HIDE_MS);
    } else if (view.phase === "idle") {
      this.hideLater(RESTORED_HIDE_MS);
    }
  }

  destroy(): void {
    this.clearHideTimer();
    this.host.remove();
  }

  private buttonsFor(view: PageTranslationView): HTMLButtonElement[] {
    switch (view.phase) {
      case "needs-activation":
        return [
          button("开始翻译", () => this.actions.activate(), true),
          button("取消", () => this.actions.restore())
        ];
      case "working":
        return [button("显示原文", () => this.actions.restore()), this.closeButton(view)];
      case "settled":
        return [button("显示原文", () => this.actions.restore()), this.closeButton(view)];
      case "error":
        return [
          button("重试", () => this.actions.retry(), true),
          button("显示原文", () => this.actions.restore()),
          this.closeButton(view)
        ];
      case "idle":
      default:
        return [];
    }
  }

  private closeButton(view: PageTranslationView): HTMLButtonElement {
    const close = button("×", () => {
      this.dismissedIn = view.phase;
      this.host.style.display = "none";
    });
    close.classList.add("close");
    close.setAttribute("aria-label", "关闭翻译状态提示");
    return close;
  }

  private hideLater(delayMs: number): void {
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      if (this.hovered || this.shadow.activeElement) {
        // The reader is using it; try again later.
        this.hideLater(delayMs);
        return;
      }
      this.host.style.display = "none";
    }, delayMs);
  }

  private clearHideTimer(): void {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }
}

function labelFor(view: PageTranslationView): string {
  const engine = view.engineLabel ? `（${view.engineLabel}）` : "";
  switch (view.phase) {
    case "error":
      return `翻译失败：${view.message}`;
    case "working":
    case "settled":
      return `${view.message}${engine}`;
    default:
      return view.message;
  }
}

function button(text: string, onClick: () => void, primary = false): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  if (primary) {
    element.classList.add("primary");
  }
  // The page's own selection and focus stay where they were.
  element.addEventListener("pointerdown", (event) => event.preventDefault());
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return element;
}

function createStyles(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .bar {
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 12px;
      max-width: min(460px, calc(100vw - 32px));
      padding: 8px 8px 8px 12px;
      border: 1px solid oklch(0.36 0.015 110);
      border-radius: 10px;
      background: oklch(0.17 0.008 110 / 0.96);
      color: oklch(0.96 0.006 110);
      box-shadow: 0 8px 24px oklch(0 0 0 / 0.28);
      font: 13px/1.45 Inter, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    }
    .bar[data-tone="error"] { border-color: oklch(0.55 0.16 25); }
    .bar[data-tone="needs-activation"] { border-color: oklch(0.64 0.13 110); }
    .label { margin: 0; flex: 1 1 auto; min-width: 0; text-wrap: pretty; }
    .buttons { display: flex; flex: 0 0 auto; gap: 4px; }
    button {
      all: unset;
      box-sizing: border-box;
      min-height: 28px;
      padding: 4px 9px;
      border-radius: 7px;
      color: oklch(0.86 0.1 110);
      font: 600 12.5px/1.2 Inter, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
      cursor: pointer;
      white-space: nowrap;
    }
    button:hover { background: oklch(0.26 0.012 110); }
    button.primary { background: oklch(0.57 0.12 110); color: oklch(0.99 0 0); }
    button.primary:hover { background: oklch(0.64 0.13 110); }
    button.close { padding: 4px 8px; color: oklch(0.72 0.018 110); font-size: 15px; }
    button:focus-visible { outline: 2px solid oklch(0.72 0.14 110); outline-offset: 2px; }
  `;
  return style;
}
