import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftTranslator } from "../src/content/fast-translator";

const NEVER = new Promise<never>(() => undefined);

interface StubOptions {
  availability?: string;
  availabilityHangs?: boolean;
  translate?: (input: string) => Promise<string>;
  translateHangs?: boolean;
  create?: () => Promise<unknown>;
}

function stubTranslatorApi(options: StubOptions) {
  const availability = options.availabilityHangs
    ? vi.fn().mockReturnValue(NEVER)
    : vi.fn().mockResolvedValue(options.availability ?? "available");
  const translate = options.translateHangs
    ? vi.fn().mockReturnValue(NEVER)
    : vi.fn(options.translate ?? (async (input: string) => `译:${input}`));
  const create = vi.fn(options.create ?? (async () => ({ translate })));
  // Chrome exposes Translator as a class, so the stub must be a function with
  // static methods. An object literal here would hide typeof-based probe bugs.
  class TranslatorStub {
    static availability = availability;
    static create = create;
  }
  vi.stubGlobal("Translator", TranslatorStub);
  return { availability, create, translate };
}

describe("on-device draft translator", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports unavailable when the browser has no Translator API", async () => {
    vi.unstubAllGlobals();
    const translator = new DraftTranslator("ja", "zh-CN");

    expect(await translator.prepare()).toBe(false);
    expect(await translator.translate("こんにちは")).toBeNull();
  });

  it("degrades quietly when the language pair is unsupported", async () => {
    const { create } = stubTranslatorApi({ availability: "unavailable" });
    const translator = new DraftTranslator("ja", "zh-CN");

    expect(await translator.prepare()).toBe(false);
    expect(await translator.translate("こんにちは")).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("requests a base language tag the Translator API accepts", async () => {
    const { availability } = stubTranslatorApi({});
    await new DraftTranslator("ja", "zh-CN").prepare();

    expect(availability).toHaveBeenCalledWith({ sourceLanguage: "ja", targetLanguage: "zh" });
  });

  it("translates a caption locally once the pair is available", async () => {
    stubTranslatorApi({ translate: async () => "你好。" });
    const translator = new DraftTranslator("ja", "zh-CN");

    expect(await translator.translate("こんにちは")).toBe("你好。");
  });

  it("probes availability once and reuses the prepared instance", async () => {
    const { availability, create } = stubTranslatorApi({});
    const translator = new DraftTranslator("ja", "zh-CN");

    await Promise.all([
      translator.translate("こんにちは"),
      translator.translate("ありがとう"),
      translator.translate("お願いします")
    ]);

    expect(availability).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
  });

  it("suppresses an untranslated echo of the source caption", async () => {
    stubTranslatorApi({ translate: async (input) => input });
    const translator = new DraftTranslator("ja", "zh-CN");

    expect(await translator.translate("こんにちは")).toBeNull();
  });

  it("never throws when the local model fails", async () => {
    stubTranslatorApi({
      translate: async () => {
        throw new Error("on-device model crashed");
      }
    });
    const translator = new DraftTranslator("ja", "zh-CN");

    expect(await translator.translate("こんにちは")).toBeNull();
  });

  it("never throws when the translator cannot be created", async () => {
    stubTranslatorApi({
      create: async () => {
        throw new Error("model download failed");
      }
    });
    const translator = new DraftTranslator("ja", "zh-CN");

    expect(await translator.prepare()).toBe(false);
    expect(await translator.translate("こんにちは")).toBeNull();
  });

  it("gives up when the availability probe never settles", async () => {
    vi.useFakeTimers();
    try {
      stubTranslatorApi({ availabilityHangs: true });
      const translator = new DraftTranslator("ja", "zh-CN");

      const prepared = translator.prepare();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(await prepared).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandons a local translation too slow to be worth showing", async () => {
    vi.useFakeTimers();
    try {
      stubTranslatorApi({ translateHangs: true });
      const translator = new DraftTranslator("ja", "zh-CN");

      const draft = translator.translate("こんにちは");
      await vi.advanceTimersByTimeAsync(800);

      expect(await draft).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a draft whose caption was already superseded", async () => {
    stubTranslatorApi({});
    const translator = new DraftTranslator("ja", "zh-CN");
    const controller = new AbortController();
    controller.abort();

    expect(await translator.translate("こんにちは", controller.signal)).toBeNull();
  });
});
