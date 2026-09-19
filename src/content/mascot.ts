import type { ExtensionMessage, PlainTranslationResponse } from "../shared/messages";
import { safeRuntimeSendMessage } from "../shared/extension-context";

/**
 * Lightweight CSS-3D mascot: floats near the selection and shows a speech bubble
 * with the local-MT translation. No WebGL dependency so the content bundle stays small.
 */
export class SelectionMascot {
  private readonly host = document.createElement("div");
  private readonly shadow = this.host.attachShadow({ mode: "open" });
  private readonly bubble = document.createElement("p");
  private readonly figure = document.createElement("div");
  private visible = false;
  private debounceTimer: number | null = null;
  private lastSelection = "";

  constructor() {
    this.host.setAttribute("data-tranlithion-mascot", "");
    this.host.style.cssText = "all:initial;position:fixed;z-index:2147483646;pointer-events:none;display:none;";
    this.bubble.className = "bubble";
    this.figure.className = "sprite";
    this.figure.innerHTML = `
      <div class="head">
        <span class="eye left"></span>
        <span class="eye right"></span>
        <span class="blush left"></span>
        <span class="blush right"></span>
        <span class="mouth"></span>
      </div>
      <div class="body"></div>
    `;
    this.shadow.append(createMascotStyles(), this.bubble, this.figure);
    document.documentElement.append(this.host);

    document.addEventListener("selectionchange", this.onSelectionChange, { passive: true });
    window.addEventListener("scroll", this.hideQuietly, { passive: true, capture: true });
  }

  destroy(): void {
    document.removeEventListener("selectionchange", this.onSelectionChange);
    window.removeEventListener("scroll", this.hideQuietly, true);
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.host.remove();
  }

  private readonly hideQuietly = (): void => {
    if (!this.visible) {
      return;
    }
    this.host.style.display = "none";
    this.visible = false;
  };

  private readonly onSelectionChange = (): void => {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.handleSelection();
    }, 280);
  };

  private async handleSelection(): Promise<void> {
    const selection = window.getSelection();
    const text = selection?.toString().replace(/\s+/g, " ").trim() ?? "";
    if (!text || text.length < 2 || text.length > 800) {
      this.hideQuietly();
      return;
    }
    if (!selection || selection.rangeCount === 0) {
      this.hideQuietly();
      return;
    }
    if (text === this.lastSelection && this.visible) {
      return;
    }
    this.lastSelection = text;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (rect.width < 2 && rect.height < 2) {
      this.hideQuietly();
      return;
    }

    this.bubble.textContent = "…";
    this.positionNear(rect);
    this.host.style.display = "block";
    this.visible = true;
    this.figure.classList.add("is-thinking");

    const response = await safeRuntimeSendMessage<PlainTranslationResponse>({
      type: "TRANSLATE_PLAIN",
      text
    } satisfies ExtensionMessage);

    if (this.lastSelection !== text) {
      return;
    }
    this.figure.classList.remove("is-thinking");
    if (!response?.ok || !response.text) {
      this.bubble.textContent = response?.error ?? "本机翻译不可用";
      return;
    }
    this.bubble.textContent = response.text;
    this.positionNear(rect);
  }

  private positionNear(rect: DOMRect): void {
    const left = Math.min(window.innerWidth - 220, Math.max(12, rect.left + rect.width / 2 - 90));
    const top = Math.max(12, rect.top - 108);
    this.host.style.left = `${Math.round(left)}px`;
    this.host.style.top = `${Math.round(top)}px`;
  }
}

function createMascotStyles(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = `
    :host { font-family: "Segoe UI", "Noto Sans SC", sans-serif; }
    .bubble {
      margin: 0 0 8px;
      max-width: 200px;
      padding: 0.45em 0.65em;
      border-radius: 12px 12px 12px 4px;
      background: oklch(0.98 0.02 95);
      color: oklch(0.22 0.02 95);
      font-size: 13px;
      line-height: 1.35;
      box-shadow: 0 8px 24px oklch(0.2 0.02 95 / 0.22);
      transform-origin: bottom left;
      animation: pop 220ms ease-out;
    }
    .sprite {
      width: 56px;
      height: 64px;
      transform-style: preserve-3d;
      perspective: 240px;
      animation: bob 2.4s ease-in-out infinite;
    }
    .sprite.is-thinking { animation: bob 0.7s ease-in-out infinite; }
    .head {
      position: relative;
      width: 44px;
      height: 44px;
      margin: 0 auto;
      border-radius: 46% 46% 40% 40%;
      background: linear-gradient(160deg, oklch(0.86 0.12 55), oklch(0.72 0.14 45));
      box-shadow:
        inset -6px -8px 0 oklch(0.62 0.12 45 / 0.35),
        4px 6px 0 oklch(0.3 0.02 95 / 0.18);
      transform: rotateY(-12deg) rotateX(8deg);
    }
    .eye {
      position: absolute;
      top: 16px;
      width: 7px;
      height: 9px;
      border-radius: 50%;
      background: oklch(0.2 0.02 95);
    }
    .eye.left { left: 11px; }
    .eye.right { right: 11px; }
    .blush {
      position: absolute;
      top: 24px;
      width: 8px;
      height: 5px;
      border-radius: 50%;
      background: oklch(0.7 0.12 25 / 0.55);
    }
    .blush.left { left: 6px; }
    .blush.right { right: 6px; }
    .mouth {
      position: absolute;
      left: 50%;
      bottom: 11px;
      width: 10px;
      height: 5px;
      margin-left: -5px;
      border-radius: 0 0 10px 10px;
      border-bottom: 2px solid oklch(0.35 0.05 25);
    }
    .body {
      width: 30px;
      height: 18px;
      margin: -4px auto 0;
      border-radius: 12px 12px 10px 10px;
      background: linear-gradient(180deg, oklch(0.55 0.1 250), oklch(0.42 0.08 250));
      transform: rotateY(-12deg);
      box-shadow: 3px 4px 0 oklch(0.3 0.02 95 / 0.15);
    }
    @keyframes bob {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-5px); }
    }
    @keyframes pop {
      from { opacity: 0; transform: translateY(6px) scale(0.94); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @media (prefers-reduced-motion: reduce) {
      .sprite, .bubble { animation: none; }
    }
  `;
  return style;
}
