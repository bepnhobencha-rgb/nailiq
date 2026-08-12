import { describe, expect, it } from "vitest";
import {
  audienceIncludesMemberRole,
  containsTechnicalReleaseLanguage,
  legacyTargetForAudience,
  normalizeReleaseAudienceRoles,
} from "@/shared/superadmin/releaseAudience";

describe("role-scoped release notices", () => {
  it("normalizes and deduplicates roles in a stable order", () => {
    expect(
      normalizeReleaseAudienceRoles(["receptionist", "owner", "owner", "customer"]),
    ).toEqual(["owner", "receptionist"]);
  });

  it("keeps legacy banner routing compatible", () => {
    expect(legacyTargetForAudience(["owner", "admin"])).toBe("owners");
    expect(legacyTargetForAudience(["receptionist", "nail_tech"])).toBe("staff");
    expect(legacyTargetForAudience(["owner", "receptionist"])).toBe("all");
  });

  it("shows exact-role notices only to affected accounts", () => {
    expect(audienceIncludesMemberRole(["receptionist"], "receptionist")).toBe(true);
    expect(audienceIncludesMemberRole(["receptionist"], "owner")).toBe(false);
    expect(audienceIncludesMemberRole([], "nail_tech")).toBe(true);
  });

  it("rejects engineering language but accepts salon language", () => {
    expect(containsTechnicalReleaseLanguage("Deploy commit 2cdd07b0 to production")).toBe(true);
    expect(containsTechnicalReleaseLanguage("Update src/app/page.tsx and run CI")).toBe(true);
    expect(
      containsTechnicalReleaseLanguage(
        "Receptionists can now see the old and new appointment time before saving.",
      ),
    ).toBe(false);
  });
});
