import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  formatGlossary,
  normalizeSettings,
  parseGlossary,
  publicSettings
} from "../src/shared/settings";

describe("translation settings", () => {
  it("parses terms, names, and removes duplicate source entries", () => {
    const glossary = parseGlossary([
      "@五条悟 = 五条悟",
      "領域展開 = 领域展开",
      "領域展開 = 不应覆盖",
      "not a glossary row"
    ].join("\n"));

    expect(glossary).toEqual([
      { source: "五条悟", target: "五条悟", kind: "name" },
      { source: "領域展開", target: "领域展开", kind: "term" }
    ]);
    expect(formatGlossary(glossary)).toContain("@五条悟 = 五条悟");
  });

  it("normalizes unsafe or malformed settings to safe defaults", () => {
    const settings = normalizeSettings({
      provider: "unknown",
      apiBaseUrl: "file:///private",
      webSocketUrl: "https://not-a-websocket.example",
      fontSizePx: 100,
      backgroundOpacity: 0,
      position: "side",
      glossary: [{ source: "  夏油杰 ", target: " 夏油杰 ", kind: "name" }]
    });

    expect(settings.provider).toBe(DEFAULT_SETTINGS.provider);
    expect(settings.apiBaseUrl).toBe(DEFAULT_SETTINGS.apiBaseUrl);
    expect(settings.webSocketUrl).toBe(DEFAULT_SETTINGS.webSocketUrl);
    expect(settings.fontSizePx).toBe(48);
    expect(settings.backgroundOpacity).toBe(0.35);
    expect(settings.position).toBe(DEFAULT_SETTINGS.position);
    expect(settings.glossary).toEqual([
      { source: "夏油杰", target: "夏油杰", kind: "name" }
    ]);
  });

  it("redacts API keys before settings reach the content script", () => {
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, apiKey: "sk-test-secret" });
    const publicValue = publicSettings(settings);

    expect(publicValue.apiKeyConfigured).toBe(true);
    expect("apiKey" in publicValue).toBe(false);
  });
});
