import { describe, expect, it } from "vitest";
import {
  isSupportedLanguage,
  normalizeAllowedLanguages,
  normalizeSupportedLanguage,
  resolveAllowedLanguage,
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

  it("normalizes an admin language allowlist without duplicates or unsupported values", () => {
    expect(normalizeAllowedLanguages(["en", "fr", "en", "de"])).toEqual(["en", "fr"]);
    expect(normalizeAllowedLanguages(null)).toEqual(["vi", "en", "es", "fr", "zh"]);
    expect(normalizeAllowedLanguages([], ["en"])).toEqual(["en"]);
  });

  it("resolves only languages the admin enabled", () => {
    expect(resolveAllowedLanguage("fr", "en", ["en"])).toBe("en");
    expect(resolveAllowedLanguage("fr", "en", ["en", "fr"])).toBe("fr");
    expect(resolveAllowedLanguage("de", "fr", ["en", "fr"])).toBe("fr");
    expect(resolveAllowedLanguage("en", "fr", ["en"])).toBe("en");
  });
});
