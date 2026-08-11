import { describe, expect, it } from "vitest";
import { salonSlugCandidates } from "../tenantRoute";

describe("salonSlugCandidates", () => {
  it("extracts a public booking salon slug", () => {
    expect(salonSlugCandidates("/nailiq-onboarding-qa-2026-08-11/qa-support-drill"))
      .toEqual(["nailiq-onboarding-qa-2026-08-11"]);
  });

  it("extracts dashboard and embed salon slugs", () => {
    expect(salonSlugCandidates("/dashboard/my-salon/center?view=day")).toEqual(["my-salon"]);
    expect(salonSlugCandidates("/embed/my-salon#booking")).toEqual(["my-salon"]);
  });

  it("rejects malformed or oversized values", () => {
    expect(salonSlugCandidates("/dashboard/../center")).toEqual([]);
    expect(salonSlugCandidates(`/dashboard/${"a".repeat(101)}`)).toEqual([]);
  });
});
