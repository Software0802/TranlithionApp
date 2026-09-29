import { describe, expect, it } from "vitest";
import { CuePrefetcher } from "../src/background/cue-prefetcher";
import type { SubtitleCue } from "../src/shared/types";

const cue = (id: string): SubtitleCue => ({
  id,
  startMs: Number(id.replace(/\D/g, "")) * 1_000,
  endMs: null,
  text: id,
  isFinal: true,
  source: "text-track"
});

/** A translator whose every request waits until the test answers it. */
function createFixture() {
  const started: string[] = [];
  const aborted: string[] = [];
  const answers = new Map<string, () => void>();
  const prefetcher = new CuePrefetcher(async (_sessionId, line, signal) => {
    started.push(line.id);
    await new Promise<void>((resolve, reject) => {
      answers.set(line.id, resolve);
      signal.addEventListener(
        "abort",
        () => {
          aborted.push(line.id);
          reject(new Error("aborted"));
        },
        { once: true }
      );
    });
  });
  return {
    prefetcher,
    started,
    aborted,
    async answer(id: string) {
      answers.get(id)?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
}

const nothingSettled = () => false;

describe("prefetching a text track ahead of playback", () => {
  it("translates the upcoming lines one at a time, in order", async () => {
    const fixture = createFixture();

    fixture.prefetcher.schedule("s", [cue("c1"), cue("c2"), cue("c3")], nothingSettled);
    expect(fixture.started).toEqual(["c1"]);

    // Each line is translated with the one before it already in context.
    await fixture.answer("c1");
    expect(fixture.started).toEqual(["c1", "c2"]);
    await fixture.answer("c2");
    expect(fixture.started).toEqual(["c1", "c2", "c3"]);
  });

  it("skips lines that already have a translation", () => {
    const fixture = createFixture();

    fixture.prefetcher.schedule("s", [cue("c1"), cue("c2")], (line) => line.id === "c1");

    expect(fixture.started).toEqual(["c2"]);
  });

  it("keeps the line in flight when the next request still wants it", async () => {
    const fixture = createFixture();
    fixture.prefetcher.schedule("s", [cue("c1"), cue("c2")], nothingSettled);

    // Playback moved on and the window grew by a line; c1 is still wanted.
    fixture.prefetcher.schedule("s", [cue("c1"), cue("c2"), cue("c3")], nothingSettled);

    expect(fixture.aborted).toEqual([]);
    expect(fixture.started).toEqual(["c1"]);
    await fixture.answer("c1");
    expect(fixture.started).toEqual(["c1", "c2"]);
  });

  it("drops lines the viewer seeked away from", () => {
    const fixture = createFixture();
    fixture.prefetcher.schedule("s", [cue("c1"), cue("c2")], nothingSettled);

    fixture.prefetcher.schedule("s", [cue("c40"), cue("c41")], nothingSettled);

    expect(fixture.aborted).toEqual(["c1"]);
  });

  it("hands a caption due now the prefetch already working on it", async () => {
    const fixture = createFixture();
    fixture.prefetcher.schedule("s", [cue("c1"), cue("c2")], nothingSettled);

    const waiting = fixture.prefetcher.claim("s", "c1");
    expect(waiting).not.toBeNull();

    // A claimed line is not abandoned by a seek: a caption is waiting on it.
    fixture.prefetcher.schedule("s", [cue("c40")], nothingSettled);
    expect(fixture.aborted).toEqual([]);

    await fixture.answer("c1");
    await expect(waiting).resolves.toBeUndefined();
    expect(fixture.started).toEqual(["c1", "c40"]);
  });

  it("lets a caption due now skip the queue instead of waiting behind it", async () => {
    const fixture = createFixture();
    fixture.prefetcher.schedule("s", [cue("c1"), cue("c2"), cue("c3")], nothingSettled);

    // c2 came on screen while c1 was still being prefetched: the caption asks
    // for it directly, and the prefetcher no longer does.
    expect(fixture.prefetcher.claim("s", "c2")).toBeNull();
    await fixture.answer("c1");

    expect(fixture.started).toEqual(["c1", "c3"]);
  });

  it("stops everything for a session that is cleared", async () => {
    const fixture = createFixture();
    fixture.prefetcher.schedule("s", [cue("c1"), cue("c2")], nothingSettled);

    fixture.prefetcher.clear("s");
    await fixture.answer("c1");

    expect(fixture.aborted).toEqual(["c1"]);
    expect(fixture.started).toEqual(["c1"]);
    expect(fixture.prefetcher.claim("s", "c2")).toBeNull();
  });

  it("keeps sessions apart", () => {
    const fixture = createFixture();

    fixture.prefetcher.schedule("a", [cue("c1")], nothingSettled);
    fixture.prefetcher.schedule("b", [cue("c9")], nothingSettled);

    expect(fixture.started).toEqual(["c1", "c9"]);
    expect(fixture.aborted).toEqual([]);
  });
});
