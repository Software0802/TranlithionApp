import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import { translateWithAgent } from "../src/background/translator";

describe("translation agent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers an explicit offline demo translation path", async () => {
    const response = await translateWithAgent({
      cue: {
        id: "demo",
        startMs: 0,
        endMs: 1_000,
        text: "こんにちは",
        isFinal: true,
        source: "text-track"
      },
      settings: { ...DEFAULT_SETTINGS, provider: "mock" },
      recentContext: [],
      rememberedTerms: []
    });

    expect(response.provider).toBe("mock");
    expect(response.text).toBe("你好。");
    expect(response.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("cancels an in-flight provider request when a newer caption takes priority", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("The request was aborted.", "AbortError")),
        { once: true }
      );
    }));
    vi.stubGlobal("fetch", fetchMock);

    const request = translateWithAgent({
      cue: {
        id: "superseded-caption",
        startMs: 0,
        endMs: null,
        text: "こんにちは",
        isFinal: true,
        source: "netflix-dom"
      },
      settings: {
        ...DEFAULT_SETTINGS,
        provider: "openai-compatible",
        apiKey: "test-key"
      },
      recentContext: [],
      rememberedTerms: [],
      signal: controller.signal
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("emits cumulative text as an OpenAI-compatible stream arrives", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"好。"}}]}\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const partials: string[] = [];

    const response = await translateWithAgent({
      cue: {
        id: "streaming-caption",
        startMs: 0,
        endMs: null,
        text: "こんにちは",
        isFinal: true,
        source: "netflix-dom"
      },
      settings: {
        ...DEFAULT_SETTINGS,
        provider: "openai-compatible",
        apiBaseUrl: "https://api.deepseek.com/v1",
        apiKey: "test-key",
        model: "deepseek-v4-flash"
      },
      recentContext: [],
      rememberedTerms: [],
      onPartial: (text) => partials.push(text)
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      stream: true,
      max_tokens: 96,
      thinking: { type: "disabled" }
    });
    expect(partials).toEqual(["你", "你好。"]);
    expect(response).toMatchObject({ text: "你好。", entityHints: [] });
  });

  it("hands the model one rendering per name, the user's", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"早上好。"}}]}\n\n'));
            controller.close();
          }
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await translateWithAgent({
      cue: {
        id: "meeting-line",
        startMs: 0,
        endMs: null,
        text: "Good morning.",
        isFinal: true,
        source: "meet-dom",
        speaker: "Alice Chen"
      },
      settings: {
        ...DEFAULT_SETTINGS,
        provider: "openai-compatible",
        apiBaseUrl: "https://api.deepseek.com/v1",
        apiKey: "test-key",
        model: "deepseek-v4-flash",
        glossary: [{ source: "Alice Chen", target: "陈爱丽", kind: "name" }]
      },
      recentContext: [],
      // What a meeting registers for a speaker it has heard from.
      rememberedTerms: [{ source: "Alice Chen", target: "Alice Chen", kind: "name" }],
      onPartial: () => undefined
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const [system] = body.messages;

    expect(system.content).toContain("Alice Chen=陈爱丽");
    expect(system.content.match(/Alice Chen=/g)).toHaveLength(1);
  });

  it("keeps terminology in the cacheable system prefix, not the per-cue message", async () => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你好。"}}]}\n\n'));
            controller.close();
          }
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await translateWithAgent({
      cue: {
        id: "cached-prefix",
        startMs: 0,
        endMs: null,
        text: "おはよう",
        isFinal: true,
        source: "netflix-dom"
      },
      settings: {
        ...DEFAULT_SETTINGS,
        provider: "openai-compatible",
        apiBaseUrl: "https://api.deepseek.com/v1",
        apiKey: "test-key",
        model: "deepseek-v4-flash"
      },
      recentContext: [{ cueId: "previous", source: "先生", translation: "老师", atMs: 1 }],
      rememberedTerms: [{ source: "五条悟", target: "五条悟", kind: "name" }],
      onPartial: () => undefined
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const [system, user] = body.messages;

    expect(system.role).toBe("system");
    expect(system.content).toContain("五条悟");
    expect(system.content).toMatch(/natural|not word-for-word|calque/i);
    // The sliding context changes every cue; keeping the glossary out of it is
    // what leaves a stable prefix for the provider to cache.
    expect(user.content).not.toContain("五条悟");
    expect(user.content).toContain("おはよう");
  });

  it("uses a saved OpenAI-compatible key only in the provider request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  translation: "你好，五条悟。",
                  entities: [{ source: "五条悟", target: "五条悟", kind: "name" }]
                })
              }
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await translateWithAgent({
      cue: {
        id: "provider-test",
        startMs: 0,
        endMs: 1_000,
        text: "五条悟さん、こんにちは。",
        isFinal: true,
        source: "text-track"
      },
      settings: {
        ...DEFAULT_SETTINGS,
        provider: "openai-compatible",
        apiBaseUrl: "https://translator.example/v1",
        apiKey: "test-key",
        model: "test-model"
      },
      recentContext: [{ cueId: "previous", source: "先生", translation: "老师", atMs: 1 }],
      rememberedTerms: [{ source: "五条悟", target: "五条悟", kind: "name" }]
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://translator.example/v1/chat/completions");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "test-model",
      messages: [
        expect.any(Object),
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("五条悟")
        })
      ]
    });
    expect(response).toMatchObject({
      provider: "openai-compatible",
      text: "你好，五条悟。",
      entityHints: [{ source: "五条悟", target: "五条悟", kind: "name" }]
    });
  });

  it("leaves a long line room to be translated whole", async () => {
    // A merged or long caption cut off at a fixed token cap would be cached
    // as if the half sentence were the whole translation.
    const encoder = new TextEncoder();
    // A fresh stream per request: a response body can only be read once.
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"很长的一句。"}}]}\n\n'));
            controller.close();
          }
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const settings = {
      ...DEFAULT_SETTINGS,
      provider: "openai-compatible" as const,
      apiKey: "test-key"
    };
    const translate = (text: string) =>
      translateWithAgent({
        cue: { id: text, startMs: 0, endMs: null, text, isFinal: true, source: "text-track" },
        settings,
        recentContext: [],
        rememberedTerms: [],
        onPartial: () => undefined
      });
    const maxTokens = (call: number) =>
      (JSON.parse(String((fetchMock.mock.calls[call] as [string, RequestInit])[1].body)) as {
        max_tokens: number;
      }).max_tokens;

    await translate("はい");
    await translate("あ".repeat(120));

    expect(maxTokens(0)).toBe(96);
    expect(maxTokens(1)).toBeGreaterThan(96);
    expect(maxTokens(1)).toBeLessThanOrEqual(400);
  });
});

