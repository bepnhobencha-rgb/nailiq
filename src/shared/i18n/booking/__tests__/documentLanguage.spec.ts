import { describe, expect, it } from "vitest";
import { resolveBookingDocumentLanguageHint } from "@/shared/i18n/booking/documentLanguage";

describe("resolveBookingDocumentLanguageHint", () => {
  it("prefers the explicit URL language", () => {
    expect(resolveBookingDocumentLanguageHint("vi", "en")).toBe("vi");
    expect(resolveBookingDocumentLanguageHint("en", "vi")).toBe("en");
  });

  it("uses the booking cookie when the URL has no supported language", () => {
    expect(resolveBookingDocumentLanguageHint(null, "vi")).toBe("vi");
    expect(resolveBookingDocumentLanguageHint("fr", "en")).toBe("en");
  });

  it("fails neutral for unsupported or missing input", () => {
    expect(resolveBookingDocumentLanguageHint(null, null)).toBeNull();
    expect(resolveBookingDocumentLanguageHint("fr", "es")).toBeNull();
  });
});
