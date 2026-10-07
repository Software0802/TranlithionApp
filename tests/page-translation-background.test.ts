import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from "../src/shared/settings";
import type { TranslationSettings } from "../src/shared/types";

/**
 * Runs the real background worker against a fake Chrome for everything page
 * translation adds: batched requests per service, the answer cache, honest
 * failures, the side panel hand-off, and putting the content script into the
 * tab the user is looking at.
 */

type Listener = (
  message: unknown,
  sender: { tab?: chrome.tabs.Tab },
  sendResponse: (response: unknown) => void
) => boolean;

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
}

const DEEPL: Partial<TranslationSettings> = {
  pageTranslateChannel: "fast-mt",
  draftProvider: "deepl",
  draftEndpointUrl: "https://api-free.deepl.com/v2/translate",
  draftApiKey: "deepl-key"
};

async function startWorker(
  options: {
    settings?: Partial<TranslationSettings>;
    granted?: boolean;
    answer?: (call: FetchCall) => Response | Promise<Response>;
    /** Whether a content script already answers in tab 7. */
    contentScript?: boolean;
    injectable?: boolean;
    /** Whether an open side panel takes the entries pushed to it. */
    panelAcks?: boolean;
  } = {}
) {
  const local = new Map<string, unknown>([
    [SETTINGS_STORAGE_KEY, { ...DEFAULT_SETTINGS, ...options.settings }]
  ]);
  const session = new Map<string, unknown>();
  let onMessage: Listener | null = null;
  let onMenuClick: ((info: unknown, tab?: chrome.tabs.Tab) => void) | null = null;
  let onCommand: ((command: string, tab?: chrome.tabs.Tab) => void) | null = null;
  const area = (store: Map<string, unknown>) => ({
    get: async (key: string | null) => (key === null ? Object.fromEntries(store) : { [key]: store.get(key) }),
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) {
        store.set(key, value);
      }
    },
    remove: async (keys: string | string[]) => {
      for (const key of [keys].flat()) {
        store.delete(key);
      }
    },
    setAccessLevel: async () => undefined
  });
  const ignored = { addListener: () => undefined };
  const events: string[] = [];
  const panelMessages: unknown[] = [];
  const tabMessages: unknown[] = [];
  const badges: Array<{ tabId: number; text: string }> = [];
  let contentScript = options.contentScript ?? false;
  const sidePanelOpen = vi.fn(async (openOptions: { tabId?: number; windowId?: number }) => {
    events.push(`open:${openOptions.tabId}`);
  });
  const executeScript = vi.fn(async () => {
    if (options.injectable === false) {
      throw new Error("Cannot access contents of the page.");
    }
    contentScript = true;
    return [];
  });

  vi.stubGlobal("chrome", {
    runtime: {
      onInstalled: ignored,
      onStartup: ignored,
      onMessage: {
        addListener: (listener: Listener) => {
          onMessage = listener;
        }
      },
      sendMessage: async (message: unknown) => {
        panelMessages.push(message);
        return options.panelAcks ? { received: true } : undefined;
      },
      lastError: undefined
    },
    storage: { local: area(local), session: area(session), onChanged: ignored },
    tabs: {
      onRemoved: ignored,
      onUpdated: ignored,
      query: async () => [],
      sendMessage: async (_tabId: number, message: { type: string; command?: string }) => {
        tabMessages.push(message);
        if (!contentScript) {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        if (message.type === "PING") {
          return { ok: true };
        }
        if (message.type === "PAGE_COMMAND") {
          return { ok: true, translated: message.command !== "restore-page", message: "已开始翻译" };
        }
        return undefined;
      }
    },
    permissions: { contains: async () => options.granted ?? true, onAdded: ignored },
    sidePanel: { open: sidePanelOpen },
    scripting: { executeScript, getRegisteredContentScripts: async () => [] },
    contextMenus: {
      onClicked: {
        addListener: (listener: typeof onMenuClick) => {
          onMenuClick = listener;
        }
      },
      removeAll: (done: () => void) => done(),
      create: () => undefined
    },
    commands: {
      onCommand: {
        addListener: (listener: typeof onCommand) => {
          onCommand = listener;
        }
      }
    },
    action: {
      setBadgeText: async (details: { tabId: number; text: string }) => {
        badges.push(details);
      },
      setBadgeBackgroundColor: async () => undefined
    }
  });

  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = { url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
      calls.push(call);
      return (
        options.answer?.(call) ??
        new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } })
      );
    })
  );

  await import("../src/background/index");
  await vi.advanceTimersByTimeAsync(0);

  const tab = { id: 7, windowId: 3, title: "ニュース" } as chrome.tabs.Tab;
  const send = (message: unknown, sender: { tab?: chrome.tabs.Tab } = { tab }) =>
    new Promise<unknown>((resolve) => {
      onMessage?.(message, sender, resolve);
    });

  return {
    calls,
    events,
    panelMessages,
    tabMessages,
    badges,
    sidePanelOpen,
    executeScript,
    send,
    /** Sends a message and reports what had happened by the time the listener returned. */
    sendAndPeek(message: unknown, sender: { tab?: chrome.tabs.Tab } = { tab }) {
      // The executor runs synchronously, so `events` below is what happened
      // before the listener returned — before any await could have run.
      const response = new Promise<unknown>((resolve) => {
        onMessage?.(message, sender, resolve);
      });
      return { eventsDuringCall: [...events], response };
    },
    translate: (texts: string[], source: string, markup = false) =>
      send({ type: "TRANSLATE_TEXTS", texts, source, markup }) as Promise<{
        ok: boolean;
        texts?: Array<string | null>;
        error?: string;
        retryable?: boolean;
      }>,
    clickMenu(info: unknown) {
      onMenuClick?.(info, tab);
      return [...events];
    },
    pressShortcut: (command: string) => onCommand?.(command, tab),
    switchTarget: (targetLanguage: TranslationSettings["targetLanguage"]) =>
      send({ type: "SAVE_SETTINGS", patch: { targetLanguage } }),
    settle: () => vi.advanceTimersByTimeAsync(0)
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

describe("page text through the configured page channel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends a batch to DeepL in one request, keeping placeholder tags, and remembers the answers", async () => {
    const worker = await startWorker({
      settings: DEEPL,
      answer: ({ body }) =>
        json({ translations: (body.text as string[]).map((text) => ({ text: `[zh] ${text}` })) })
    });

    const first = await worker.translate(["詳しくは<t0>こちら</t0>", "お問い合わせ"], "ja", true);

    expect(worker.calls).toHaveLength(1);
    expect(worker.calls[0].body).toEqual({
      text: ["詳しくは<t0>こちら</t0>", "お問い合わせ"],
      source_lang: "JA",
      target_lang: "ZH-HANS",
      tag_handling: "xml"
    });
    expect(first).toEqual({ ok: true, texts: ["[zh] 詳しくは<t0>こちら</t0>", "[zh] お問い合わせ"] });

    // The same menu on the next page costs nothing.
    const again = await worker.translate(["お問い合わせ"], "ja", true);
    expect(again.texts).toEqual(["[zh] お問い合わせ"]);
    expect(worker.calls).toHaveLength(1);
  });

  it("says plainly when DeepL's quota is used up and does not retry forever", async () => {
    const worker = await startWorker({ settings: DEEPL, answer: () => json({}, 456) });

    const result = await worker.translate(["こんにちは"], "ja");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("额度已用完");
    expect(result.retryable).toBe(false);
  });

  it("asks LibreTranslate in the language each string was detected in", async () => {
    const worker = await startWorker({
      settings: { pageTranslateChannel: "local-mt", localMtEnabled: true, sourceLanguage: "ja" },
      answer: ({ body }) => json({ translatedText: `译:${String(body.q)}` })
    });

    const result = await worker.translate(["Sign in", "Help"], "en");

    expect(worker.calls.map((call) => call.body)).toEqual([
      { q: "Sign in", source: "en", target: "zh", format: "text" },
      { q: "Help", source: "en", target: "zh", format: "text" }
    ]);
    expect(result.texts).toEqual(["译:Sign in", "译:Help"]);
  });

  it("asks a chat model for a JSON array and splits a batch it miscounts", async () => {
    const worker = await startWorker({
      settings: {
        pageTranslateChannel: "llm",
        provider: "openai-compatible",
        apiBaseUrl: "https://llm.example/v1",
        apiKey: "test-key"
      },
      answer: ({ body }) => {
        const texts = JSON.parse(
          (body.messages as Array<{ content: string }>)[1].content
        ) as string[];
        // Merges two strings into one answer whenever it gets more than one.
        const translations = texts.length > 1 ? [texts.join("")] : texts.map((text) => `译:${text}`);
        return json({ choices: [{ message: { content: JSON.stringify({ translations }) } }] });
      }
    });

    const result = await worker.translate(["一つ目", "二つ目"], "ja", true);

    expect(worker.calls).toHaveLength(3);
    expect(worker.calls[0].url).toBe("https://llm.example/v1/chat/completions");
    expect((worker.calls[0].body.messages as Array<{ content: string }>)[0].content).toContain("<t0>");
    expect(result.texts).toEqual(["译:一つ目", "译:二つ目"]);
  });

  it("refuses honestly when the page channel is not set up, and sends nothing anywhere", async () => {
    const disabled = await startWorker({
      settings: { pageTranslateChannel: "local-mt", localMtEnabled: false }
    });
    expect((await disabled.translate(["こんにちは"], "ja")).error).toContain("启用本机 LibreTranslate");
    expect(disabled.calls).toHaveLength(0);
    vi.resetModules();

    const noKey = await startWorker({ settings: { ...DEEPL, draftApiKey: "" } });
    expect((await noKey.translate(["こんにちは"], "ja")).error).toContain("DeepL API Key");
    expect(noKey.calls).toHaveLength(0);
    vi.resetModules();

    const notGranted = await startWorker({ settings: DEEPL, granted: false });
    expect((await notGranted.translate(["こんにちは"], "ja")).error).toContain("api-free.deepl.com");
    expect(notGranted.calls).toHaveLength(0);
  });

  it("returns nothing asked in a language the user has since left", async () => {
    const held: { release?: () => void } = {};
    const worker = await startWorker({
      settings: DEEPL,
      answer: ({ body }) =>
        new Promise<Response>((resolve) => {
          held.release = () =>
            resolve(json({ translations: (body.text as string[]).map((text) => ({ text: `[zh] ${text}` })) }));
        })
    });

    const pending = worker.translate(["ありがとう"], "ja");
    await worker.settle();
    await worker.switchTarget("en");
    held.release?.();

    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("语言设置已更改");
  });
});

describe("selections in the side panel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("opens the panel inside the user's click, before anything is awaited, and hands the text over", async () => {
    const worker = await startWorker();

    const { eventsDuringCall, response } = worker.sendAndPeek({
      type: "SHOW_IN_SIDE_PANEL",
      text: "詳しくはこちらをご覧ください",
      source: "ja"
    });

    // Chrome allows sidePanel.open only while the click still counts as a gesture.
    expect(eventsDuringCall).toEqual(["open:7"]);
    expect(await response).toEqual({ ok: true });
    expect(worker.panelMessages).toContainEqual({
      type: "SIDE_PANEL_ENTRY",
      entry: expect.objectContaining({
        text: "詳しくはこちらをご覧ください",
        source: "ja",
        pageTitle: "ニュース",
        windowId: 3
      })
    });
    // A panel that was still loading picks it up from the inbox — in its own
    // window only, and only once.
    const otherWindow = (await worker.send({ type: "GET_SIDE_PANEL_INBOX", windowId: 99 })) as { entries: unknown[] };
    expect(otherWindow.entries).toHaveLength(0);
    const inbox = (await worker.send({ type: "GET_SIDE_PANEL_INBOX", windowId: 3 })) as { entries: unknown[] };
    expect(inbox.entries).toHaveLength(1);
    const again = (await worker.send({ type: "GET_SIDE_PANEL_INBOX", windowId: 3 })) as { entries: unknown[] };
    expect(again.entries).toHaveLength(0);
  });

  it("keeps nothing for later once an open panel has taken the selection", async () => {
    const worker = await startWorker({ panelAcks: true });

    await worker.send({ type: "SHOW_IN_SIDE_PANEL", text: "ありがとう", source: "ja" });
    await worker.settle();

    // A panel opened again later starts empty instead of replaying it.
    const inbox = (await worker.send({ type: "GET_SIDE_PANEL_INBOX", windowId: 3 })) as { entries: unknown[] };
    expect(inbox.entries).toHaveLength(0);
  });

  it("opens the panel from the context menu with the selected text", async () => {
    const worker = await startWorker();

    const duringClick = worker.clickMenu({
      menuItemId: "tranlithion-selection-side-panel",
      selectionText: "Terms of Service"
    });
    await worker.settle();

    expect(duringClick).toEqual(["open:7"]);
    const inbox = (await worker.send({ type: "GET_SIDE_PANEL_INBOX" })) as {
      entries: Array<{ text: string; source: unknown }>;
    };
    expect(inbox.entries[0]).toMatchObject({ text: "Terms of Service", source: null });
  });

  it("does not open the panel for a selection it cannot take", async () => {
    const worker = await startWorker();

    const result = await worker.send({ type: "SHOW_IN_SIDE_PANEL", text: "字".repeat(6_000) });

    expect(result).toMatchObject({ ok: false });
    expect(worker.sidePanelOpen).not.toHaveBeenCalled();
  });
});

describe("one click from the toolbar, the menu or the shortcut", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("puts the content script into the tab the popup names, then translates the page", async () => {
    const worker = await startWorker({ contentScript: false });

    // The popup is not a tab: it names the tab it acts on.
    const pending = worker.send({ type: "PAGE_COMMAND", command: "translate-page", tabId: 7 }, {});
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;

    expect(worker.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ["content/index.js"]
    });
    expect(result).toMatchObject({ ok: true, translated: true });
  });

  it("does not inject a second copy where one already answers", async () => {
    const worker = await startWorker({ contentScript: true });

    await worker.send({ type: "PAGE_COMMAND", command: "toggle-page", tabId: 7 }, {});

    expect(worker.executeScript).not.toHaveBeenCalled();
  });

  it("explains pages Chrome does not let extensions into", async () => {
    const worker = await startWorker({ contentScript: false, injectable: false });

    const result = await worker.send({ type: "PAGE_COMMAND", command: "translate-page", tabId: 7 }, {});

    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("不允许扩展运行");
  });

  it("reports an untranslated page without injecting anything just to ask", async () => {
    const worker = await startWorker({ contentScript: false });

    const result = await worker.send({ type: "PAGE_COMMAND", command: "page-state", tabId: 7 }, {});

    expect(result).toEqual({ ok: true, translated: false });
    expect(worker.executeScript).not.toHaveBeenCalled();
  });

  it("toggles the page from the shortcut and the context menu", async () => {
    const worker = await startWorker({ contentScript: true });

    worker.pressShortcut("translate-page");
    worker.clickMenu({ menuItemId: "tranlithion-translate-page" });
    await worker.settle();

    const commands = worker.tabMessages.filter(
      (message) => (message as { type: string }).type === "PAGE_COMMAND"
    );
    expect(commands).toEqual([
      { type: "PAGE_COMMAND", command: "toggle-page" },
      { type: "PAGE_COMMAND", command: "toggle-page" }
    ]);
  });

  it("marks a translated tab on the toolbar badge in text, not only colour", async () => {
    const worker = await startWorker();

    await worker.send({ type: "PAGE_TRANSLATION_STATE", state: "translated" });
    await worker.send({ type: "PAGE_TRANSLATION_STATE", state: "idle" });

    expect(worker.badges).toEqual([
      { tabId: 7, text: "译" },
      { tabId: 7, text: "" }
    ]);
  });
});
