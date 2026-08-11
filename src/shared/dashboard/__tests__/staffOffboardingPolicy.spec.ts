import { describe, expect, it } from "vitest";

import { resolveStaffOffboardingContactPlan } from "@/shared/dashboard/staffOffboardingPolicy";

const base = {
  customerRequestedStaff: true,
  hasEmail: false,
  hasPhone: false,
  notifyEmail: false,
  notifySms: false,
  manualContactConfirmed: false,
};

describe("staff offboarding contact policy", () => {
  it("blocks a named request without a reachable notice or direct contact", () => {
    expect(resolveStaffOffboardingContactPlan(base)).toBeNull();
  });

  it("accepts only a selected channel that the guest can actually receive", () => {
    expect(
      resolveStaffOffboardingContactPlan({
        ...base,
        notifyEmail: true,
      }),
    ).toBeNull();
    expect(
      resolveStaffOffboardingContactPlan({
        ...base,
        hasEmail: true,
        notifyEmail: true,
      }),
    ).toBe("notification_selected");
    expect(
      resolveStaffOffboardingContactPlan({
        ...base,
        hasPhone: true,
        notifySms: true,
      }),
    ).toBe("notification_selected");
  });

  it("records a confirmed direct conversation as the fallback", () => {
    expect(
      resolveStaffOffboardingContactPlan({
        ...base,
        manualContactConfirmed: true,
      }),
    ).toBe("manual_contact");
  });

  it("does not force outreach for an ordinary staff assignment", () => {
    expect(
      resolveStaffOffboardingContactPlan({
        ...base,
        customerRequestedStaff: false,
      }),
    ).toBe("not_required");
  });
});
