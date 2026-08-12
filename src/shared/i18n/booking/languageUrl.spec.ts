import { describe, expect, it } from "vitest";

import { bookingLanguagePath } from "./languageUrl";

describe("bookingLanguagePath", () => {
  it("replaces an explicit language override", () => {
    expect(
      bookingLanguagePath(
        "https://www.nailiq.ca/nailiq-qa-2026-07-26?lang=vi",
        "en",
      ),
    ).toBe("/nailiq-qa-2026-07-26?lang=en");
  });

  it("preserves other booking parameters and the hash", () => {
    expect(
      bookingLanguagePath(
        "https://www.nailiq.ca/tech-nails?preview=true&tryon=abc&lang=en#services",
        "vi",
      ),
    ).toBe("/tech-nails?preview=true&tryon=abc&lang=vi#services");
  });

  it("adds a language override when the URL has none", () => {
    expect(
      bookingLanguagePath("https://www.nailiq.ca/hilite-anaheim", "vi"),
    ).toBe("/hilite-anaheim?lang=vi");
  });
});
