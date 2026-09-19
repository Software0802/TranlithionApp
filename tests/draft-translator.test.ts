import { afterEach, describe, expect, it, vi } from "vitest";
import { translateDraft } from "../src/background/draft-translator";
import { DEFAULT_SETTINGS, publicSettings } from "../src/shared/settings";
import type { TranslationSettings } from "../src/shared/types";

const DEEPL: TranslationSettings = {
  ...DEFAULT_SETTINGS,
  draftCaptions: true,
  draftProvider: "deepl",
  draftEndpointUrl: "https://api-free.deepl.com/v2/translate",
  draftApiKey: "draft-key"
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("remote draft translator", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the DeepL request shape and reads its translation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ translations: [{ detected_source_language: "JA", text: "你好。" }] })
    );
    vi.stubGlobal("fetch", fetchMock);

    const draft = await translateDraft({ text: "こんにちは", settings: DEEPL });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api-free.deepl.com/v2/translate");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "DeepL-Auth-Key draft-key" });
    expect(JSON.parse(String(init.body))).toEqual({
      text: ["こんにちは"],
      source_lang: "JA",
      target_lang: "ZH-HANS"
    });
    expect(draft).toBe("你好。");
  });

  it("sends the documented generic shape for a custom endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ translation: "谢谢。" }));
    vi.stubGlobal("fetch", fetchMock);

    const draft = await translateDraft({
      text: "ありがとう",
      settings: {
        ...DEEPL,
        draftProvider: "custom",
        draftEndpointUrl: "https://nmt.example/translate",
        draftApiKey: "custom-key"
      }
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: "Bearer custom-key" });
    expect(JSON.parse(String(init.body))).toEqual({
      text: "ありがとう",
      source: "ja",
      target: "zh-CN"
    });
    expect(draft).toBe("谢谢。");
  });

  it("never spends a request when the draft channel is off or local", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await translateDraft({ text: "こんにちは", settings: { ...DEEPL, draftCaptions: false } })).toBeNull();
    expect(await translateDraft({ text: "こんにちは", settings: { ...DEEPL, draftProvider: "browser" } })).toBeNull();
    expect(await translateDraft({ text: "こんにちは", settings: { ...DEEPL, draftApiKey: "" } })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("degrades to no draft when the endpoint rejects the request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 403 })));

    expect(await translateDraft({ text: "こんにちは", settings: DEEPL })).toBeNull();
  });

  it("degrades to no draft when the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    expect(await translateDraft({ text: "こんにちは", settings: DEEPL })).toBeNull();
  });

  it("suppresses an untranslated echo of the caption", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ translations: [{ text: "こんにちは" }] }))
    );

    expect(await translateDraft({ text: "こんにちは", settings: DEEPL })).toBeNull();
  });

  it("keeps a caption that reads the same in both languages", async () => {
    // As the meeting's final channel there is nothing better coming: a name,
    // an acronym or a figure simply reads the same, and reporting it as "no
    // result" would call a working channel dead and take the caption away.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ translations: [{ text: "Figma." }] }))
    );

    expect(await translateDraft({ text: "Figma.", settings: DEEPL, asFinal: true })).toBe("Figma.");
  });

  it("renders the user's glossary onto a meeting's final caption", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ translations: [{ text: "在 Figma 里改。" }] }))
    );

    const caption = await translateDraft({
      text: "Figmaで直す。",
      settings: DEEPL,
      asFinal: true,
      terminology: [{ source: "Figma", target: "菲格玛", kind: "term" }]
    });

    expect(caption).toBe("在 菲格玛 里改。");
  });

  it("leaves a film's draft caption exactly as the service wrote it", async () => {
    // Drafts run on YouTube and Netflix too, where the model's answer is
    // still coming and applies the glossary itself. Rewriting the draft in
    // between would only make the two disagree in front of the viewer.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ translations: [{ text: "在 Figma 里改。" }] }))
    );

    const draft = await translateDraft({
      text: "Figmaで直す。",
      settings: DEEPL,
      terminology: [{ source: "Figma", target: "菲格玛", kind: "term" }]
    });

    expect(draft).toBe("在 Figma 里改。");
  });

  it("drops a draft whose caption was superseded before the request began", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    expect(
      await translateDraft({ text: "こんにちは", settings: DEEPL, signal: controller.signal })
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the draft key out of anything a content script receives", () => {
    const shared = publicSettings(DEEPL) as unknown as Record<string, unknown>;

    expect(shared.draftApiKey).toBeUndefined();
    expect(shared.apiKey).toBeUndefined();
    expect(shared.draftApiKeyConfigured).toBe(true);
    expect(JSON.stringify(shared)).not.toContain("draft-key");
  });
});
