import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  translateWithAgent,
  warmUpEndpoint,
  warmUpTranslator
} from "../src/background/translator";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import type { SubtitleCue, TranslationSettings } from "../src/shared/types";

/**
 * The connection a caption rides on. Opening one costs round trips before the
 * request can even be sent, so a caption should find one already open — but
 * the server must still see one question and one answer per connection at a
 * time, exactly as it did when every caption opened its own.
 */

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  readonly sent: Array<{ requestId: string; cue: SubtitleCue }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as { requestId: string; cue: SubtitleCue });
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) {
      return;
    }
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  /** The server accepts the connection. */
  accept(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  /** The server answers the request on this socket that carried `text`. */
  answer(text: string, translation: string): void {
    const request = this.sent.find((sent) => sent.cue.text === text);
    this.onmessage?.({ data: JSON.stringify({ requestId: request?.requestId, translation }) });
  }

  /** The connection fails the way a browser reports it: error, then close. */
  fail(): void {
    this.onerror?.();
    this.close();
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const sockets = () => FakeSocket.instances;
const socketFor = (text: string) =>
  FakeSocket.instances.find((socket) => socket.sent.some((sent) => sent.cue.text === text));

function line(text: string): SubtitleCue {
  return { id: `cue:${text}`, startMs: 0, endMs: null, text, isFinal: true, source: "netflix-dom" };
}

function socketSettings(path: string): TranslationSettings {
  return { ...DEFAULT_SETTINGS, provider: "websocket", webSocketUrl: `ws://localhost:8787/${path}` };
}

function translate(settings: TranslationSettings, text: string, signal?: AbortSignal) {
  return translateWithAgent({
    cue: line(text),
    settings,
    recentContext: [],
    rememberedTerms: [],
    signal
  });
}

describe("reusing WebSocket connections between captions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends the next caption on the connection the last one was answered on", async () => {
    const settings = socketSettings("reuse");

    const first = translate(settings, "こんにちは");
    sockets()[0].accept();
    sockets()[0].answer("こんにちは", "你好。");
    await expect(first).resolves.toMatchObject({ text: "你好。", provider: "websocket" });

    const second = translate(settings, "ありがとう");
    await flush();
    sockets()[0].answer("ありがとう", "谢谢。");

    await expect(second).resolves.toMatchObject({ text: "谢谢。" });
    expect(sockets()).toHaveLength(1);
  });

  it("gives two captions in flight a connection each", async () => {
    // A server that reads one message at a time never makes the caption on
    // screen wait behind a prefetch sent on the same line.
    const settings = socketSettings("parallel");
    const onScreen = translate(settings, "おはよう");
    const ahead = translate(settings, "おやすみ");
    for (const socket of sockets()) {
      socket.accept();
    }

    socketFor("おやすみ")?.answer("おやすみ", "晚安。");
    socketFor("おはよう")?.answer("おはよう", "早上好。");

    await expect(onScreen).resolves.toMatchObject({ text: "早上好。" });
    await expect(ahead).resolves.toMatchObject({ text: "晚安。" });
    expect(sockets()).toHaveLength(2);
    expect(sockets().map((socket) => socket.sent.length)).toEqual([1, 1]);
  });

  it("works with a server that closes after every answer, even with two in flight", async () => {
    const settings = socketSettings("one-shot");
    const first = translate(settings, "こんにちは");
    const second = translate(settings, "ありがとう");
    for (const socket of sockets()) {
      socket.accept();
    }

    socketFor("こんにちは")?.answer("こんにちは", "你好。");
    socketFor("こんにちは")?.close();
    await expect(first).resolves.toMatchObject({ text: "你好。" });

    socketFor("ありがとう")?.answer("ありがとう", "谢谢。");
    await expect(second).resolves.toMatchObject({ text: "谢谢。" });

    // The closed connection is not handed to the next caption.
    const third = translate(settings, "さようなら");
    await flush();
    expect(socketFor("さようなら")).not.toBe(socketFor("こんにちは"));
    socketFor("さようなら")?.answer("さようなら", "再见。");
    await expect(third).resolves.toMatchObject({ text: "再见。" });
  });

  it("closes a cancelled caption's connection, as it always did", async () => {
    const settings = socketSettings("cancel");
    const controller = new AbortController();
    const stale = translate(settings, "こんにちは", controller.signal);
    sockets()[0].accept();

    controller.abort();

    await expect(stale).rejects.toMatchObject({ code: "CANCELLED" });
    expect(sockets()[0].readyState).toBe(FakeSocket.CLOSED);
    const next = translate(settings, "ありがとう");
    expect(sockets()).toHaveLength(2);
    sockets()[1].accept();
    sockets()[1].answer("ありがとう", "谢谢。");
    await expect(next).resolves.toMatchObject({ text: "谢谢。" });
  });

  it("recovers on the next caption after a connection goes silent", async () => {
    // After a network change a socket can still read as open while nothing
    // on it ever arrives again. It costs one caption, not every one after it.
    const settings = socketSettings("silent");
    const first = translate(settings, "こんにちは");
    sockets()[0].accept();
    sockets()[0].answer("こんにちは", "你好。");
    await first;

    const lost = translate(settings, "ありがとう");
    const outcome = expect(lost).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "翻译 WebSocket 连接超时。"
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await outcome;

    const next = translate(settings, "さようなら");
    expect(sockets()).toHaveLength(2);
    sockets()[1].accept();
    sockets()[1].answer("さようなら", "再见。");
    await expect(next).resolves.toMatchObject({ text: "再见。" });
  });

  it("does not trust a connection left idle too long", async () => {
    const settings = socketSettings("stale");
    const first = translate(settings, "こんにちは");
    sockets()[0].accept();
    sockets()[0].answer("こんにちは", "你好。");
    await first;

    await vi.advanceTimersByTimeAsync(61_000);
    void translate(settings, "ありがとう").catch(() => undefined);

    expect(sockets()).toHaveLength(2);
    expect(sockets()[0].readyState).toBe(FakeSocket.CLOSED);
  });

  it("fails the caption in flight when the connection drops", async () => {
    const request = translate(socketSettings("drop"), "こんにちは");
    sockets()[0].accept();

    sockets()[0].close();

    await expect(request).rejects.toMatchObject({
      code: "NETWORK",
      message: "翻译 WebSocket 服务意外断开。"
    });
  });

  it("says so plainly when the server cannot be reached", async () => {
    const request = translate(socketSettings("unreachable"), "こんにちは");

    sockets()[0].fail();

    await expect(request).rejects.toMatchObject({
      code: "NETWORK",
      message: "无法连接到翻译 WebSocket 服务。"
    });
  });

  it("fails only the caption an unreadable frame arrived for", async () => {
    const settings = socketSettings("garbage");
    const broken = translate(settings, "こんにちは");
    const fine = translate(settings, "ありがとう");
    for (const socket of sockets()) {
      socket.accept();
    }

    socketFor("こんにちは")?.onmessage?.({ data: "<html>502</html>" });
    socketFor("ありがとう")?.answer("ありがとう", "谢谢。");

    await expect(broken).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(fine).resolves.toMatchObject({ text: "谢谢。" });
  });
});

describe("opening the connection before the first caption", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reaches the model's endpoint without the key or any caption text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 405 }));
    vi.stubGlobal("fetch", fetchMock);

    await warmUpTranslator(
      {
        ...DEFAULT_SETTINGS,
        provider: "openai-compatible",
        apiBaseUrl: "https://warm.example/v1",
        apiKey: "secret-key"
      },
      1_000
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://warm.example/v1/chat/completions");
    expect(init.method).toBe("HEAD");
    expect(init.body).toBeUndefined();
    expect(JSON.stringify(init.headers ?? {})).not.toContain("secret-key");
  });

  it("does not warm a connection that is still fresh", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await warmUpEndpoint("https://fresh.example/v2/translate", 1_000);
    await warmUpEndpoint("https://fresh.example/v2/translate", 20_000);
    expect(fetchMock).toHaveBeenCalledOnce();

    await warmUpEndpoint("https://fresh.example/v2/translate", 40_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never lets a failed warm-up reach the caption path", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(warmUpEndpoint("https://down.example/translate", 1_000)).resolves.toBeUndefined();
  });

  it("opens the WebSocket the first caption then finds open", async () => {
    const settings = socketSettings("warm");

    await warmUpTranslator(settings, 1_000);
    sockets()[0].accept();

    const request = translate(settings, "こんにちは");
    await flush();
    sockets()[0].answer("こんにちは", "你好。");

    await expect(request).resolves.toMatchObject({ text: "你好。" });
    expect(sockets()).toHaveLength(1);
  });

  it("hands a connection still opening to the first caption instead of opening another", async () => {
    const settings = socketSettings("warming");

    await warmUpTranslator(settings, 1_000);
    const request = translate(settings, "こんにちは");
    sockets()[0].accept();
    sockets()[0].answer("こんにちは", "你好。");

    await expect(request).resolves.toMatchObject({ text: "你好。" });
    expect(sockets()).toHaveLength(1);
    expect(sockets()[0].sent).toHaveLength(1);
  });
});
