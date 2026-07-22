import { describe, expect, it } from "vitest";

import {
  dashboardPathForRole,
  isOwner,
  normalizeSalonMemberRole,
} from "@/shared/lib/salonMemberRole";

describe("normalizeSalonMemberRole", () => {
  it.each(["owner", "admin", "senior", "nail_tech", "receptionist"] as const)(
    "preserves the known %s role",
    (role) => {
      expect(normalizeSalonMemberRole(role)).toBe(role);
    },
  );

  it.each([null, undefined, "", "manager", "OWNER_ADMIN", 123])(
    "fails closed for an unknown role value: %p",
    (role) => {
      const normalized = normalizeSalonMemberRole(role);

      expect(normalized).toBe("nail_tech");
      expect(isOwner(normalized)).toBe(false);
      expect(dashboardPathForRole("test-salon", normalized)).toBe(
        "/dashboard/test-salon/center",
      );
    },
  );

  it("normalizes casing and surrounding whitespace for known roles", () => {
    expect(normalizeSalonMemberRole("  RECEPTIONIST ")).toBe("receptionist");
  });
});
