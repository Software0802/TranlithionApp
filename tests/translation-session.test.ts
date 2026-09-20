import { describe, expect, it } from "vitest";
import {
  SessionJobQueue,
  SupersededJobError,
  TranslationSessionStore
} from "../src/shared/translation-session";
import type { SubtitleCue, TranslationResult } from "../src/shared/types";

const cue = (id: string, text = id): SubtitleCue => ({
  id,
  startMs: 0,
  endMs: 1_000,
  text,
  isFinal: true,
  source: "text-track"
});

const result = (text: string, name?: string): TranslationResult => ({
  text,
  provider: "mock",
  latencyMs: 1,
  entityHints: name
    ? [{ source: name, target: name, kind: "name" }]
    : []
});

describe("translation session memory", () => {
  it("keeps a bounded ordered context and reusable entity hints", () => {
    const store = new TranslationSessionStore();
    for (let index = 0; index < 10; index += 1) {
      store.record("session", cue(`cue-${index}`), result(`译文-${index}`, "五条悟"));
    }

    expect(store.getContext("session")).toHaveLength(8);
    expect(store.getContext("session")[0].cueId).toBe("cue-2");
    expect(store.getEntityHints("session")).toEqual([
      { source: "五条悟", target: "五条悟", kind: "name" }
    ]);
    expect(store.getCached("session", "cue-9")?.text).toBe("译文-9");
  });

  it("keeps one context line per cue when the same line is recorded twice", () => {
    // A meeting line is recorded once by the translation and again when it
    // settles. Appending it twice would spend half the model's window
    // repeating what it has already been told.
    const store = new TranslationSessionStore();
    store.record("session", cue("cue-1", "Good morning."), result("早上好。"));
    store.record("session", cue("cue-2", "Let's begin."), result("我们开始吧。"));
    store.record("session", cue("cue-1", "Good morning."), result("早上好。"));

    expect(store.getContext("session").map((line) => line.cueId)).toEqual(["cue-1", "cue-2"]);
  });

  it("forgets what it learned for a pair the user has switched away from", () => {
    // Everything a session remembers is written in one target language. After
    // a mid-call switch it is not stale by age, it is simply the wrong
    // language, and serving it would caption the meeting in a language nobody
    // asked for.
    const store = new TranslationSessionStore();
    store.useLanguagePair("session", "ja", "zh-CN");
    store.record("session", cue("cue-1", "こんにちは"), result("你好。", "悟空"));

    store.useLanguagePair("session", "ja", "en");

    expect(store.getCachedByText("session", "こんにちは")).toBeUndefined();
    expect(store.getCached("session", "cue-1")).toBeUndefined();
    expect(store.getContext("session")).toEqual([]);
    expect(store.getEntityHints("session")).toEqual([]);
  });

  it("keeps everything while the pair stays the same", () => {
    const store = new TranslationSessionStore();
    store.useLanguagePair("session", "ja", "zh-CN");
    store.record("session", cue("cue-1", "こんにちは"), result("你好。"));
    store.useLanguagePair("session", "ja", "zh-CN");

    expect(store.getCachedByText("session", "こんにちは")?.text).toBe("你好。");
  });

  it("keeps restored context when the worker wakes on the same pair", () => {
    const store = new TranslationSessionStore();
    store.useLanguagePair("session", "ja", "zh-CN");
    store.record("session", cue("cue-1", "こんにちは"), result("你好。"));

    const woken = new TranslationSessionStore();
    woken.restore("session", store.snapshot("session"));
    woken.useLanguagePair("session", "ja", "zh-CN");

    expect(woken.getContext("session")).toHaveLength(1);
  });

  it("forgets a call completely when consent is withdrawn", () => {
    // Unchecking the transcript mid-call, or clearing the records, has to
    // take back what is already remembered — the lines, the caches, and the
    // name of whoever said them, which is part of the record of the call and
    // not a term the user taught us.
    const store = new TranslationSessionStore();
    store.useLanguagePair("call", "ja", "zh-CN");
    store.markMeetingSession("call");
    store.record("call", cue("cue-1", "こんにちは"), result("你好。", "Alice Chen"));

    store.forgetMeetingSessions();

    expect(store.getContext("call")).toEqual([]);
    expect(store.getCached("call", "cue-1")).toBeUndefined();
    expect(store.getCachedByText("call", "こんにちは")).toBeUndefined();
    expect(store.getEntityHints("call")).toEqual([]);
  });

  it("leaves an episode playing in another tab exactly as it was", () => {
    const store = new TranslationSessionStore();
    store.useLanguagePair("film", "ja", "zh-CN");
    store.record("film", cue("cue-1", "こんにちは"), result("你好。", "悟空"));

    store.forgetMeetingSessions();

    expect(store.getContext("film")).toHaveLength(1);
    expect(store.getCachedByText("film", "こんにちは")?.text).toBe("你好。");
    expect(store.getEntityHints("film")).toEqual([
      { source: "悟空", target: "悟空", kind: "name" }
    ]);
  });

  it("still knows a restored session was a call after the worker slept", () => {
    const store = new TranslationSessionStore();
    store.useLanguagePair("call", "ja", "zh-CN");
    store.markMeetingSession("call");
    store.record("call", cue("cue-1", "こんにちは"), result("你好。"));

    const woken = new TranslationSessionStore();
    woken.restore("call", store.snapshot("call"));
    woken.forgetMeetingSessions();

    expect(woken.getContext("call")).toEqual([]);
  });

  it("answers a repeat from a channel that has no cue to key on", () => {
    // The machine-translation meeting channels never reach the model, so the
    // text memory is what stops a sentence being paid for twice in one call.
    const store = new TranslationSessionStore();
    store.rememberText("session", "Figma.", result("Figma."));

    expect(store.getCachedByText("session", "Figma.")?.text).toBe("Figma.");
    // `snapshot` is exactly what reaches extension storage: a line handled
    // this way leaves nothing of what was said behind it.
    expect(store.snapshot("session")?.recent).toEqual([]);
  });

  it("reuses translations by source text across different cue ids", () => {
    const store = new TranslationSessionStore();
    store.record(
      "session",
      { ...cue("netflix-dom:1000:open:abc", "こんにちは"), source: "netflix-dom" },
      result("你好。")
    );

    expect(store.getCachedByText("session", "こんにちは")?.text).toBe("你好。");
    expect(store.getCachedByText("session", " こんにちは ")?.text).toBe("你好。");
    expect(store.getCached("session", "netflix-dom:5000:open:abc")).toBeUndefined();
  });

  it("bounds the text-keyed cache independently of cue ids", () => {
    const store = new TranslationSessionStore();
    for (let index = 0; index < 220; index += 1) {
      store.record("session", cue(`cue-${index}`, `原文-${index}`), result(`译文-${index}`));
    }

    expect(store.getCachedByText("session", "原文-0")).toBeUndefined();
    expect(store.getCachedByText("session", "原文-219")?.text).toBe("译文-219");
  });

  it("persists context and name hints without persisting a cue cache", () => {
    const store = new TranslationSessionStore();
    store.record("session", cue("cue-1", "悟空"), result("悟空", "悟空"));
    const snapshot = store.snapshot("session");
    const restored = new TranslationSessionStore();

    restored.restore("session", snapshot);

    expect(restored.getContext("session")).toHaveLength(1);
    expect(restored.getEntityHints("session")).toEqual([
      { source: "悟空", target: "悟空", kind: "name" }
    ]);
    expect(restored.getCached("session", "cue-1")).toBeUndefined();
  });

  it("serializes translation jobs for one viewing session", async () => {
    const queue = new SessionJobQueue();
    const order: string[] = [];
    const first = queue.enqueue("session", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("first");
      return "first";
    });
    const second = queue.enqueue("session", async () => {
      order.push("second");
      return "second";
    });

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(order).toEqual(["first", "second"]);
  });

  it("cancels stale live-caption requests without waiting for their cleanup", async () => {
    const queue = new SessionJobQueue();
    const started: string[] = [];
    let resolveFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    const first = queue.enqueueLatest("session", async (signal) => {
      started.push("first");
      resolveFirstStarted();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return "first";
    });

    await firstStarted;
    const stale = queue.enqueueLatest("session", async () => {
      started.push("stale");
      return "stale";
    });
    const newest = queue.enqueueLatest("session", async () => {
      started.push("newest");
      return "newest";
    });

    await expect(first).rejects.toBeInstanceOf(SupersededJobError);
    await expect(stale).rejects.toBeInstanceOf(SupersededJobError);
    await expect(newest).resolves.toBe("newest");
    expect(started).toEqual(["first", "stale", "newest"]);
  });
});
