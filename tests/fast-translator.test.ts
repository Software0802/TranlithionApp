import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftTranslator, LocalMtTranslator } from "../src/content/fast-translator";

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

  it("keeps a caption that reads the same in both languages", async () => {
    // As the final channel there is nothing better coming: a name, an acronym
    // or a figure simply reads the same, and calling that "no result" would
    // report a working channel as dead and take the caption off screen.
    stubTranslatorApi({ translate: async (input) => input });
    const translator = new DraftTranslator("ja", "zh-CN", true);

    expect(await translator.translate("Figma")).toBe("Figma");
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

  it("waits longer for the on-device model when it is the caption itself", async () => {
    vi.useFakeTimers();
    try {
      // Meeting mode with stock settings makes this channel the final caption:
      // nothing slower is waiting behind it, and a cold model that answers at
      // 1.5 s is a line the user reads rather than a line that disappears.
      let settle: ((text: string) => void) | undefined;
      stubTranslatorApi({
        translate: () => new Promise<string>((resolve) => {
          settle = resolve;
        })
      });
      const translator = new DraftTranslator("ja", "zh-CN", true);

      const caption = translator.translate("こんにちは");
      await vi.advanceTimersByTimeAsync(1_500);
      settle?.("你好");

      expect(await caption).toBe("你好");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still gives up on a final-channel translation that never answers", async () => {
    vi.useFakeTimers();
    try {
      stubTranslatorApi({ translateHangs: true });
      const translator = new DraftTranslator("ja", "zh-CN", true);

      const caption = translator.translate("こんにちは");
      await vi.advanceTimersByTimeAsync(4_000);

      expect(await caption).toBeNull();
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

describe("local LibreTranslate caption channel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drops a line the local server is too slow to answer", async () => {
    vi.useFakeTimers();
    try {
      // Meeting jobs run one at a time, so a local server that takes the
      // background's full-page budget would push every later line minutes
      // behind the conversation instead of costing this one line.
      vi.stubGlobal("chrome", {
        runtime: { id: "tranlithion-test", sendMessage: () => NEVER }
      });
      const channel = new LocalMtTranslator();

      const caption = channel.translate("こんにちは");
      await vi.advanceTimersByTimeAsync(4_000);

      expect(await caption).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a line the local server answers within the budget", async () => {
    vi.useFakeTimers();
    try {
      let settle: ((response: unknown) => void) | undefined;
      vi.stubGlobal("chrome", {
        runtime: {
          id: "tranlithion-test",
          sendMessage: () =>
            new Promise((resolve) => {
              settle = resolve;
            })
        }
      });
      const channel = new LocalMtTranslator();

      const caption = channel.translate("こんにちは");
      await vi.advanceTimersByTimeAsync(2_000);
      settle?.({ ok: true, text: "你好" });

      expect(await caption).toBe("你好");
    } finally {
      vi.useRealTimers();
    }
  });
});
