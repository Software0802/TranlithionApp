import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPTION_SETTLE_DELAY_MS } from "../src/content/adapters/netflix-caption-adapter";
import { SubtitleController } from "../src/content/subtitle-controller";
import { DEFAULT_SETTINGS, publicSettings } from "../src/shared/settings";
import type {
  PublicTranslationSettings,
  SubtitleCue,
  TranslationResponse
} from "../src/shared/types";

/**
 * Drives Netflix with DeepL as the only translator — the real adapter, the
 * controller and the overlay — against a fake page and a fake worker.
 *
 * With DeepL alone there is no model behind it to fill the line in later, so
 * DeepL has to be asked as the caption itself: a final channel's budget, and
 * a session that is an episode, not a call.
 */

interface FakeNode {
  id: string;
  className: string;
  textContent: string;
  [key: string]: unknown;
}

interface SentMessage {
  type: string;
  [key: string]: unknown;
}

function createFixture() {
  let captionText = "";
  let notifyMutation: (() => void) | null = null;
  const nodes: FakeNode[] = [];
  const styles = new Map<string, FakeNode>();
  const messages: SentMessage[] = [];
  const modelRequests: SubtitleCue[] = [];
  const videoListeners = new Map<string, Set<() => void>>();

  function createNode(tag: string): FakeNode {
    const attributes: Record<string, string> = {};
    const node: FakeNode = {
      tagName: tag.toUpperCase(),
      id: "",
      className: "",
      textContent: "",
      hidden: false,
      lang: "",
      style: { setProperty: () => undefined } as Record<string, unknown>,
      dataset: {},
      attributes,
      classList: { toggle: () => undefined },
      setAttribute: (name: string, value: string) => {
        attributes[name] = value;
      },
      append: () => undefined,
      attachShadow: () => ({ append: () => undefined }),
      remove: () => {
        styles.delete(node.id);
      }
    };
    nodes.push(node);
    return node;
  }

  function caption(): string | null {
    const host = nodes.find(
      (node) => "data-tranlithion-overlay" in (node.attributes as Record<string, string>)
    );
    const style = host?.style as Record<string, unknown> | undefined;
    if (style?.display !== "block") {
      return null;
    }
    return nodes.find((node) => node.className === "translation")?.textContent ?? null;
  }

  const root = {
    get innerText() {
      return captionText;
    },
    get textContent() {
      return captionText;
    },
    getBoundingClientRect: () => ({ width: 700, height: 40, left: 40, top: 380, right: 740, bottom: 420 })
  };
  const video = {
    currentTime: 0,
    playbackRate: 1,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 450, width: 800, height: 450 }),
    addEventListener: (type: string, listener: () => void) => {
      const forType = videoListeners.get(type) ?? new Set<() => void>();
      forType.add(listener);
      videoListeners.set(type, forType);
    },
    removeEventListener: (type: string, listener: () => void) => {
      videoListeners.get(type)?.delete(listener);
    }
  };

  vi.stubGlobal("location", { hostname: "www.netflix.com", pathname: "/watch/1" });
  vi.stubGlobal("window", {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    setTimeout: (handler: () => void, ms?: number) => globalThis.setTimeout(handler, ms),
    clearTimeout: (handle: number) => globalThis.clearTimeout(handle),
    setInterval: (handler: () => void, ms?: number) => globalThis.setInterval(handler, ms),
    clearInterval: (handle: number) => globalThis.clearInterval(handle)
  });
  vi.stubGlobal("document", {
    fullscreenElement: null,
    body: { append: () => undefined },
    head: {
      append: (node: FakeNode) => {
        styles.set(node.id, node);
      }
    },
    createElement: createNode,
    getElementById: (id: string) => styles.get(id) ?? null,
    querySelectorAll: (selector: string) =>
      selector === '[data-uia="player-subtitle-text"]' ? [root] : [],
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        notifyMutation = callback;
      }
      observe() {}
      disconnect() {
        notifyMutation = null;
      }
    }
  );
  vi.stubGlobal("chrome", {
    runtime: {
      id: "tranlithion-test",
      sendMessage: async (message: SentMessage) => {
        messages.push(message);
        if (message.type === "DRAFT_TRANSLATE") {
          return { ok: true, text: `[DeepL] ${String(message.text)}` };
        }
        return { ok: true };
      }
    }
  });

  const settings: PublicTranslationSettings = {
    ...publicSettings(DEFAULT_SETTINGS),
    apiKeyConfigured: true,
    draftCaptions: true,
    draftProvider: "deepl",
    draftApiKeyConfigured: true
  };
  const controller = new SubtitleController(
    { kind: "video", video: video as unknown as HTMLVideoElement },
    settings,
    async (cue: SubtitleCue): Promise<TranslationResponse> => {
      modelRequests.push(cue);
      return { ok: false, error: { code: "CANCELLED", message: "not expected" } };
    },
    () => undefined
  );
  controller.start();

  return {
    controller,
    caption,
    modelRequests,
    deepLRequests: () => messages.filter((message) => message.type === "DRAFT_TRANSLATE"),
    warmUps: () => messages.filter((message) => message.type === "WARM_UP_TRANSLATOR"),
    async render(text: string) {
      captionText = text;
      notifyMutation?.();
      await vi.advanceTimersByTimeAsync(CAPTION_SETTLE_DELAY_MS);
    },
    async wait(ms: number) {
      await vi.advanceTimersByTimeAsync(ms);
    },
    resume() {
      for (const listener of [...(videoListeners.get("play") ?? [])]) {
        listener();
      }
    }
  };
}

describe("Netflix with DeepL as the only translator", () => {
  let fixture: ReturnType<typeof createFixture> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    fixture?.controller.destroy();
    fixture = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("asks DeepL for the caption itself, not for a draft of it", async () => {
    fixture = createFixture();
    await fixture.wait(0);

    await fixture.render("こんにちは");
    await fixture.wait(0);

    expect(fixture.caption()).toBe("[DeepL] こんにちは");
    expect(fixture.deepLRequests()).toEqual([
      expect.objectContaining({ text: "こんにちは", asFinal: true, meeting: false })
    ]);
    expect(fixture.modelRequests).toEqual([]);
  });

  it("opens DeepL's connection, never the unused model's, and again after a pause", async () => {
    fixture = createFixture();
    await fixture.wait(0);

    expect(fixture.warmUps()).toEqual([
      { type: "WARM_UP_TRANSLATOR", model: false, draft: true }
    ]);

    fixture.resume();

    // The worker decides whether the connection is due another warm-up.
    expect(fixture.warmUps()).toHaveLength(2);
    expect(fixture.warmUps()[1]).toMatchObject({ model: false, draft: true });
  });
});
