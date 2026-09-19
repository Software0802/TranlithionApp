import { describe, expect, it } from "vitest";
import {
  errorMessageOf,
  isExtensionContextInvalidatedError
} from "../src/shared/extension-context";

describe("extension context helpers", () => {
  it("detects the Chrome invalidated-context error message", () => {
    expect(isExtensionContextInvalidatedError(new Error("Extension context invalidated."))).toBe(
      true
    );
    expect(isExtensionContextInvalidatedError(new Error("network failed"))).toBe(false);
  });

  it("detects cross-realm-like plain objects with a message field", () => {
    expect(
      isExtensionContextInvalidatedError({ message: "Extension context invalidated." })
    ).toBe(true);
    expect(errorMessageOf({ message: "Extension context invalidated." })).toContain(
      "Extension context invalidated"
    );
  });
});
