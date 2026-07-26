import { describe, expect, it } from "vitest";
import {
  isSupportedLanguage,
  normalizeSupportedLanguage,
} from "@/shared/voiceai/config";

describe("Voice AI language configuration", () => {
  it("accepts every supported phone language, including French", () => {
    for (const language of ["vi", "en", "es", "fr", "zh"]) {
      expect(isSupportedLanguage(language)).toBe(true);
      expect(normalizeSupportedLanguage(language)).toBe(language);
    }
  });

  it("falls back safely for missing or tampered settings", () => {
    expect(normalizeSupportedLanguage(null)).toBe("en");
    expect(normalizeSupportedLanguage("de")).toBe("en");
    expect(normalizeSupportedLanguage("de", "fr")).toBe("fr");
  });
});
