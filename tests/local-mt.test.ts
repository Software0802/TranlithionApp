import { describe, expect, it } from "vitest";
import { toLibreTranslateLang } from "../src/background/local-mt";

describe("local LibreTranslate helpers", () => {
  it("maps app language tags to LibreTranslate codes", () => {
    expect(toLibreTranslateLang("ja")).toBe("ja");
    expect(toLibreTranslateLang("en")).toBe("en");
    expect(toLibreTranslateLang("zh-CN")).toBe("zh");
  });
});
