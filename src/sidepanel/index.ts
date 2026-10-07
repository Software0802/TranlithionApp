import { isLanguageTag, languageLabel, type LanguageTag } from "../shared/language";
import {
  isExtensionMessage,
  type ExtensionMessage,
  type SettingsResponse,
  type SidePanelEntry,
  type SidePanelInboxResponse,
  type TextsTranslationResponse
} from "../shared/messages";
import {
  detectTextLanguage,
  emptyScriptTally,
  pageLanguageContext,
  pageTextDestination,
  tallyScripts
} from "../shared/page-translation";
import { normalizeSelectedText, translateSelectedText } from "../shared/selection-translation";
import { OnDeviceTranslatorPool } from "../shared/translator-api";
import type { PublicTranslationSettings } from "../shared/types";

/**
 * The side panel: selections the user sent here, translated and kept side by
 * side with the page for as long as the panel is open. Nothing here is
 * written to storage — closing the panel is clearing it.
 */

type EntryState = "translating" | "done" | "error" | "needs-activation" | "same-language";

interface PanelEntry {
  id: string;
  text: string;
  source: LanguageTag | null;
  pageTitle: string;
  state: EntryState;
  /** The translation, or what to tell the user instead. */
  output: string;
  engineLabel: string;
  /** Bumped per translation so a late answer for an old request is dropped. */
  request: number;
}

const MAX_ENTRIES = 30;

const targetLabel = byId<HTMLParagraphElement>("target-label");
const clearButton = byId<HTMLButtonElement>("clear-entries");
const composer = byId<HTMLFormElement>("composer");
const composerText = byId<HTMLTextAreaElement>("composer-text");
const composerSource = byId<HTMLSelectElement>("composer-source");
const activation = byId<HTMLDivElement>("activation");
const activateButton = byId<HTMLButtonElement>("activate");
const statusLine = byId<HTMLParagraphElement>("panel-status");
const list = byId<HTMLOListElement>("entries");
const emptyState = byId<HTMLParagraphElement>("empty-state");
const destination = byId<HTMLParagraphElement>("destination");

let settings: PublicTranslationSettings | null = null;
let pool: OnDeviceTranslatorPool | null = null;
let entries: PanelEntry[] = [];
const seen = new Set<string>();
/** This panel's window: every window has its own side panel. */
let windowId: number | null = null;

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isExtensionMessage(message)) {
    return false;
  }
  if (message.type === "SIDE_PANEL_ENTRY") {
    const forOtherWindow =
      windowId !== null && message.entry.windowId !== null && message.entry.windowId !== windowId;
    // Only a panel that took the entry says so; until then it waits in the inbox.
    if (!forOtherWindow && addEntry(message.entry)) {
      sendResponse({ received: true });
    }
  } else if (message.type === "SETTINGS_UPDATED") {
    applySettings(message.settings);
  }
  return false;
});

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  submitComposer();
});
composerText.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    submitComposer();
  }
});
clearButton.addEventListener("click", () => {
  entries = [];
  render();
  setStatus("");
});
activateButton.addEventListener("click", () => {
  // Inside the click: this is the activation Chrome is waiting for.
  const waiting = entries.filter((entry) => entry.state === "needs-activation");
  const sources = waiting.flatMap((entry) => (entry.source ? [entry.source] : []));
  activation.hidden = true;
  void currentPool()
    .activate(sources)
    .then((ready) => {
      if (!ready) {
        setStatus("Chrome 仍然没有启用本地翻译模型。可以在扩展设置里换一个网页翻译通道。", "error");
      }
      for (const entry of waiting) {
        void translateEntry(entry);
      }
    });
});

void initialize();

async function initialize(): Promise<void> {
  try {
    windowId = (await chrome.windows.getCurrent()).id ?? null;
  } catch {
    windowId = null;
  }
  const response = await send<SettingsResponse>({ type: "GET_PUBLIC_SETTINGS" });
  const loaded = response?.settings;
  if (!loaded || !("apiKeyConfigured" in loaded)) {
    setStatus("无法读取扩展设置。请关闭侧边栏后重新打开。", "error");
    return;
  }
  applySettings(loaded);
  const inbox = await send<SidePanelInboxResponse>({
    type: "GET_SIDE_PANEL_INBOX",
    ...(windowId !== null ? { windowId } : {})
  });
  for (const entry of inbox?.entries ?? []) {
    addEntry(entry);
  }
  render();
}

function applySettings(next: PublicTranslationSettings): void {
  const targetChanged = settings !== null && settings.targetLanguage !== next.targetLanguage;
  const channelChanged =
    settings !== null &&
    (settings.pageTranslateChannel !== next.pageTranslateChannel ||
      settings.draftProvider !== next.draftProvider ||
      settings.provider !== next.provider);
  settings = next;
  targetLabel.textContent = `译为${languageLabel(next.targetLanguage)}`;
  destination.textContent = `网页文字的去向：${pageTextDestination(next)}`;
  if (targetChanged) {
    pool?.destroy();
    pool = null;
  }
  if (targetChanged || channelChanged) {
    // Every translation shown is in the old language or from the old service.
    for (const entry of entries) {
      void translateEntry(entry);
    }
  }
}

function currentPool(): OnDeviceTranslatorPool {
  if (!pool) {
    pool = new OnDeviceTranslatorPool(settings?.targetLanguage ?? "zh-CN", (fraction) => {
      if (fraction < 1) {
        setStatus(`正在下载 Chrome 本地翻译模型…${Math.round(fraction * 100)}%（只需下载一次）`);
      } else {
        setStatus("");
      }
    });
  }
  return pool;
}

function submitComposer(): void {
  const text = normalizeSelectedText(composerText.value);
  if (!text) {
    composerText.focus();
    return;
  }
  const chosen = composerSource.value;
  addEntry(
    {
      id: crypto.randomUUID(),
      text,
      source: isLanguageTag(chosen) ? chosen : null,
      pageTitle: "",
      windowId,
      at: Date.now()
    },
    true
  );
  composerText.value = "";
}

/** Whether the panel took the entry (or already has it). */
function addEntry(incoming: SidePanelEntry, typed = false): boolean {
  if (seen.has(incoming.id)) {
    return true;
  }
  if (!settings) {
    return false;
  }
  seen.add(incoming.id);
  const text = normalizeSelectedText(incoming.text);
  if (!text) {
    return true;
  }
  const entry: PanelEntry = {
    id: incoming.id,
    text,
    source: incoming.source ?? detect(text),
    pageTitle: typed ? "" : incoming.pageTitle,
    state: "translating",
    output: "",
    engineLabel: "",
    request: 0
  };
  entries = [entry, ...entries].slice(0, MAX_ENTRIES);
  void translateEntry(entry);
  return true;
}

/** Without the page around it, bare Han text is read by its own kana, or as Chinese. */
function detect(text: string): LanguageTag | null {
  const tally = emptyScriptTally();
  tallyScripts(tally, text);
  return detectTextLanguage(text, pageLanguageContext({ langAttribute: null, tally }));
}

async function translateEntry(entry: PanelEntry): Promise<void> {
  const current = settings;
  if (!current) {
    return;
  }
  const request = ++entry.request;
  const target = current.targetLanguage;
  if (!entry.source) {
    finish(entry, "error", "认不出这段文字的语言（支持日语、英语、中文）。可以在下方手动选择原文语言。");
    return;
  }
  if (entry.source === target) {
    finish(
      entry,
      "same-language",
      `这段文字看起来已经是${languageLabel(target)}。如果识别错了，可以在下方改选原文语言。`
    );
    return;
  }
  entry.state = "translating";
  entry.output = "正在翻译…";
  render();
  const result = await translateSelectedText(entry.text, entry.source, current, {
    pool: currentPool,
    send: (message) => send<TextsTranslationResponse>(message)
  });
  if (request !== entry.request || !entries.includes(entry)) {
    return;
  }
  if (result.ok) {
    entry.engineLabel = result.engineLabel;
    finish(entry, "done", result.text);
    return;
  }
  if (result.needsActivation) {
    activation.hidden = false;
    finish(entry, "needs-activation", "等待启用 Chrome 本地翻译模型…");
    return;
  }
  finish(entry, "error", result.error);
}

function finish(entry: PanelEntry, state: EntryState, output: string): void {
  entry.state = state;
  entry.output = output;
  render();
}

function render(): void {
  list.replaceChildren(...entries.map(renderEntry));
  emptyState.hidden = entries.length > 0;
  clearButton.disabled = entries.length === 0;
  if (!entries.some((entry) => entry.state === "needs-activation")) {
    activation.hidden = true;
  }
}

function renderEntry(entry: PanelEntry): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "entry";
  item.dataset.state = entry.state;

  const translation = document.createElement("p");
  translation.className = "entry-translation";
  translation.textContent = entry.output;
  if (entry.state === "done" && settings) {
    translation.lang = settings.targetLanguage;
  }

  const source = document.createElement("p");
  source.className = "entry-source";
  source.textContent = entry.text;
  if (entry.source) {
    source.lang = entry.source;
  }
  source.title = "点击展开或收起原文";
  source.addEventListener("click", () => {
    source.dataset.expanded = source.dataset.expanded === "true" ? "false" : "true";
  });

  const meta = document.createElement("div");
  meta.className = "entry-meta";
  const language = document.createElement("select");
  language.setAttribute("aria-label", "原文语言");
  for (const tag of ["ja", "en", "zh-CN"] as const) {
    const option = document.createElement("option");
    option.value = tag;
    option.textContent = `${languageLabel(tag)} →`;
    language.append(option);
  }
  if (!entry.source) {
    const unknown = document.createElement("option");
    unknown.value = "";
    unknown.textContent = "未识别 →";
    language.prepend(unknown);
  }
  language.value = entry.source ?? "";
  language.addEventListener("change", () => {
    entry.source = isLanguageTag(language.value) ? language.value : null;
    void translateEntry(entry);
  });
  const origin = document.createElement("span");
  origin.className = "entry-origin";
  origin.textContent = [
    settings ? languageLabel(settings.targetLanguage) : "",
    entry.state === "done" ? entry.engineLabel : "",
    entry.pageTitle ? `来自「${entry.pageTitle}」` : ""
  ]
    .filter(Boolean)
    .join(" · ");
  const actions = document.createElement("div");
  actions.className = "entry-actions";
  if (entry.state === "done") {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "复制";
    copy.setAttribute("aria-label", "复制译文");
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(entry.output).then(
        () => {
          copy.textContent = "已复制";
        },
        () => {
          copy.textContent = "复制失败";
        }
      );
    });
    actions.append(copy);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "移除";
  remove.setAttribute("aria-label", "移除这条译文");
  remove.addEventListener("click", () => {
    entries = entries.filter((candidate) => candidate !== entry);
    render();
  });
  actions.append(remove);
  meta.append(language, origin, actions);

  item.append(translation, source, meta);
  return item;
}

function setStatus(message: string, state: "info" | "error" = "info"): void {
  statusLine.textContent = message;
  statusLine.dataset.state = state;
}

async function send<T>(message: ExtensionMessage): Promise<T | undefined> {
  try {
    return (await chrome.runtime.sendMessage(message)) as T;
  } catch {
    return undefined;
  }
}


function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element: ${id}`);
  }
  return element as T;
}
