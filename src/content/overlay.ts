import type { PublicTranslationSettings } from "../shared/types";

const BROWSER_OVERLAY_LAYER = "2147483646";

export class SubtitleOverlay {
  private readonly host = document.createElement("div");
  private readonly shadow = this.host.attachShadow({ mode: "closed" });
  private readonly translation = document.createElement("p");
  private readonly original = document.createElement("p");
  private readonly panel = document.createElement("section");
  private readonly resizeObserver = new ResizeObserver(() => this.syncBounds());
  private visible = false;
  private lastTranslation = "";
  private lastOriginal = "";
  private lastPending = false;
  private lastDraft = false;
  private lastForceOriginal = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private settings: PublicTranslationSettings
  ) {
    this.host.setAttribute("data-tranlithion-overlay", "");
    this.host.style.position = "fixed";
    this.host.style.pointerEvents = "none";
    this.host.style.zIndex = BROWSER_OVERLAY_LAYER;
    this.host.style.display = "none";
    this.host.setAttribute("role", "region");
    this.host.setAttribute("aria-label", "Tranlithion 实时翻译字幕");
    this.host.setAttribute("aria-live", "off");

    this.translation.className = "translation";
    this.translation.lang = "zh-CN";
    this.original.className = "original";
    this.original.lang = "ja";
    this.panel.className = "caption";
    this.panel.append(this.translation, this.original);
    this.shadow.append(createStyles(), this.panel);

    document.body.append(this.host);
    this.resizeObserver.observe(this.video);
    window.addEventListener("resize", this.syncBounds, { passive: true });
    window.addEventListener("scroll", this.syncBounds, { passive: true, capture: true });
    document.addEventListener("fullscreenchange", this.handleFullscreenChange);
    this.applySettings(settings);
    this.syncBounds();
  }

  updateSettings(settings: PublicTranslationSettings): void {
    this.settings = settings;
    this.applySettings(settings);
  }

  /** Whether the overlay host is currently displayed. */
  isShowing(): boolean {
    return this.visible;
  }

  show(input: {
    translation: string;
    original: string;
    pending?: boolean;
    draft?: boolean;
    forceOriginal?: boolean;
  }): void {
    const pending = Boolean(input.pending);
    const draft = Boolean(input.draft);
    const forceOriginal = Boolean(input.forceOriginal);
    const showOriginal = this.settings.showOriginal || forceOriginal;
    const unchanged =
      this.visible &&
      this.lastTranslation === input.translation &&
      this.lastOriginal === input.original &&
      this.lastPending === pending &&
      this.lastDraft === draft &&
      this.lastForceOriginal === forceOriginal &&
      this.original.hidden === !showOriginal;
    if (unchanged) {
      return;
    }

    this.lastTranslation = input.translation;
    this.lastOriginal = input.original;
    this.lastPending = pending;
    this.lastDraft = draft;
    this.lastForceOriginal = forceOriginal;
    this.translation.textContent = input.translation;
    this.original.textContent = input.original;
    this.original.hidden = !showOriginal;
    this.panel.classList.toggle("is-pending", pending);
    // A draft is real, readable text, so it stays at full contrast. The marker
    // only has to be honest that a better translation may still replace it.
    this.panel.classList.toggle("is-draft", draft);
    this.host.style.display = "block";
    this.visible = true;
    this.syncBounds();
  }

  hide(): void {
    this.visible = false;
    this.lastTranslation = "";
    this.lastOriginal = "";
    this.lastPending = false;
    this.lastDraft = false;
    this.lastForceOriginal = false;
    this.host.style.display = "none";
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    window.removeEventListener("resize", this.syncBounds);
    window.removeEventListener("scroll", this.syncBounds, true);
    document.removeEventListener("fullscreenchange", this.handleFullscreenChange);
    this.host.remove();
  }

  private applySettings(settings: PublicTranslationSettings): void {
    this.host.style.setProperty("--caption-font-size", `${settings.fontSizePx}px`);
    this.host.style.setProperty("--caption-backdrop", String(settings.backgroundOpacity));
    this.host.dataset.position = settings.position;
  }

  private readonly handleFullscreenChange = (): void => {
    const fullscreenTarget = document.fullscreenElement;
    const nextParent = fullscreenTarget?.contains(this.video) ? fullscreenTarget : document.body;
    if (this.host.parentElement !== nextParent) {
      nextParent.append(this.host);
    }
    this.syncBounds();
  };

  private readonly syncBounds = (): void => {
    if (!this.visible) {
      return;
    }
    const rect = this.video.getBoundingClientRect();
    const isVisible = rect.width >= 120 && rect.height >= 90;
    this.host.style.display = isVisible ? "block" : "none";
    if (!isVisible) {
      return;
    }
    this.host.style.left = `${Math.round(rect.left)}px`;
    this.host.style.top = `${Math.round(rect.top)}px`;
    this.host.style.width = `${Math.round(rect.width)}px`;
    this.host.style.height = `${Math.round(rect.height)}px`;
  };
}

function createStyles(): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = `
    :host {
      color: oklch(0.98 0.002 110);
      font-family: Inter, "Noto Sans SC", "Hiragino Sans", system-ui, sans-serif;
      line-height: 1.4;
    }
    .caption {
      position: absolute;
      left: 50%;
      width: min(88%, 1,040px);
      transform: translateX(-50%);
      box-sizing: border-box;
      padding: 0.38em 0.62em 0.44em;
      border-radius: 10px;
      background: oklch(0.11 0.006 110 / var(--caption-backdrop));
      color: oklch(0.98 0.002 110);
      text-align: center;
      text-wrap: balance;
      text-shadow: 0 1px 2px oklch(0 0 0 / 0.9);
      /* Keep transitions off: Netflix sticky updates would otherwise fade/flicker. */
      transition: none;
    }
    :host([data-position="bottom"]) .caption { bottom: 12%; }
    :host([data-position="middle"]) .caption { top: 50%; transform: translate(-50%, -50%); }
    :host([data-position="top"]) .caption { top: 8%; }
    .translation {
      margin: 0;
      font-size: var(--caption-font-size);
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    .original {
      margin: 0.18em 0 0;
      color: oklch(0.9 0.01 110);
      font-size: calc(var(--caption-font-size) * 0.72);
      font-weight: 500;
    }
    .is-pending { opacity: 0.78; }
    .is-draft .translation {
      text-decoration: underline;
      text-decoration-color: oklch(0.98 0.002 110 / 0.3);
      text-decoration-thickness: 0.06em;
      text-underline-offset: 0.22em;
    }
  `;
  return style;
}
