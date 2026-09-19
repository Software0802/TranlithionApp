import { describe, expect, it } from "vitest";
import { shouldReplaceCaption } from "../src/shared/types";

describe("caption stage ordering", () => {
  it("lets each channel upgrade the caption it is racing against", () => {
    expect(shouldReplaceCaption("none", "draft")).toBe(true);
    expect(shouldReplaceCaption("none", "streaming")).toBe(true);
    expect(shouldReplaceCaption("draft", "streaming")).toBe(true);
    expect(shouldReplaceCaption("draft", "final")).toBe(true);
    expect(shouldReplaceCaption("streaming", "final")).toBe(true);
  });

  it("keeps a late local draft from regressing a finished caption", () => {
    expect(shouldReplaceCaption("final", "draft")).toBe(false);
    expect(shouldReplaceCaption("streaming", "draft")).toBe(false);
  });

  it("keeps a stale stream chunk from regressing the final translation", () => {
    expect(shouldReplaceCaption("final", "streaming")).toBe(false);
  });

  it("ignores a repeat of the stage already on screen", () => {
    expect(shouldReplaceCaption("draft", "draft")).toBe(false);
    expect(shouldReplaceCaption("final", "final")).toBe(false);
  });
});
