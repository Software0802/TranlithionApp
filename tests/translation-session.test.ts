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
