import { afterEach, describe, expect, it, vi } from "vitest";
import { toLibreTranslateLang, translateWithLibreTranslate } from "../src/background/local-mt";
import { DEFAULT_SETTINGS } from "../src/shared/settings";

const settings = { ...DEFAULT_SETTINGS, localMtEnabled: true };

function stubLibreTranslate(translatedText: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ translatedText })
    }))
  );
}

describe("local LibreTranslate helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps app language tags to LibreTranslate codes", () => {
    expect(toLibreTranslateLang("ja")).toBe("ja");
    expect(toLibreTranslateLang("en")).toBe("en");
    expect(toLibreTranslateLang("zh-CN")).toBe("zh");
  });

  it("returns a translation that reads the same in both languages", async () => {
    // A name, an acronym or a figure survives translation unchanged. Reporting
    // that as "no result" would let a caller call the server dead over a line
    // it translated correctly.
    stubLibreTranslate("Figma");

    expect(await translateWithLibreTranslate("Figma", settings)).toBe("Figma");
  });

  it("reports nothing when the server answers with an empty string", async () => {
    stubLibreTranslate("   ");

    expect(await translateWithLibreTranslate("Figma", settings)).toBeNull();
  });
});
