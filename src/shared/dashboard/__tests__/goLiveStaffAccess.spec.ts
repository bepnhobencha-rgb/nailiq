import { describe, expect, it } from "vitest";
import { resolveReadinessStaffAccess } from "@/shared/dashboard/goLiveStaffAccess";

const staff = {
  id: "staff-1",
  name: "QA Tech",
  jobRole: "nail_tech",
  userId: "user-1",
};

describe("resolveReadinessStaffAccess", () => {
  it("passes a linked staff login only with an exact active salon membership", () => {
    expect(
      resolveReadinessStaffAccess(
        [staff],
        [{ userId: "user-1", role: "nail_tech" }],
      ),
    ).toEqual({
      valid: true,
      staff: [
        {
          ...staff,
          membershipRole: "nail_tech",
          accessActive: true,
        },
      ],
    });
  });

  it("fails closed for a missing, wrong-tenant, or unsupported membership", () => {
    expect(resolveReadinessStaffAccess([staff], []).valid).toBe(false);
    expect(
      resolveReadinessStaffAccess(
        [staff],
        [{ userId: "another-user", role: "nail_tech" }],
      ).valid,
    ).toBe(false);
    expect(
      resolveReadinessStaffAccess(
        [staff],
        [{ userId: "user-1", role: "future_role" }],
      ).valid,
    ).toBe(false);
  });

  it("keeps booking-only staff valid without inventing an Auth membership", () => {
    expect(
      resolveReadinessStaffAccess([{ ...staff, userId: null }], []),
    ).toEqual({
      valid: true,
      staff: [
        {
          ...staff,
          userId: null,
          membershipRole: null,
          accessActive: null,
        },
      ],
    });
  });

  it("rejects a linked account when the staff job role itself is not bookable", () => {
    expect(
      resolveReadinessStaffAccess(
        [{ ...staff, jobRole: "receptionist" }],
        [{ userId: "user-1", role: "receptionist" }],
      ).valid,
    ).toBe(false);
  });
});
