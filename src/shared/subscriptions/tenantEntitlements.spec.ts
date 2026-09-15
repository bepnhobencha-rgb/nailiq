import { describe, expect, it } from "vitest";

import {
  resolveTenantEntitlements,
  TRIAL_EXPIRY_POLICY_FLAG,
  withTrialExpiryPolicy,
} from "./tenantEntitlements";

const enrolled = {
  archived_at: null,
  superadmin_locked_at: null,
  subscription_status: "trialing",
  trial_ends_at: "2026-09-15T12:00:00.000Z",
  feature_flags: { [TRIAL_EXPIRY_POLICY_FLAG]: 1 },
};

describe("tenant trial entitlements", () => {
  it("keeps an enrolled trial operational before its exact deadline", () => {
    const result = resolveTenantEntitlements(
      enrolled,
      new Date("2026-09-15T11:59:59.999Z"),
    );
    expect(result.state).toBe("active_trial");
    expect(result.canCreateNewBooking).toBe(true);
    expect(result.canRunAutonomousAi).toBe(true);
  });

  it("enters continuity at the exact trial deadline", () => {
    const result = resolveTenantEntitlements(
      enrolled,
      new Date("2026-09-15T12:00:00.000Z"),
    );
    expect(result.state).toBe("trial_continuity");
    expect(result.canCreateNewBooking).toBe(false);
    expect(result.canServiceExistingBooking).toBe(true);
    expect(result.canSendTransactionalReminder).toBe(true);
    expect(result.canRunMarketing).toBe(false);
    expect(result.canStartVoiceSession).toBe(false);
    expect(result.canDispatchNewCharge).toBe(false);
  });

  it("becomes read-only at the exact end of the seven-day continuity window", () => {
    const result = resolveTenantEntitlements(
      enrolled,
      new Date("2026-09-22T12:00:00.000Z"),
    );
    expect(result.state).toBe("trial_read_only");
    expect(result.canViewOperationalData).toBe(true);
    expect(result.canExportData).toBe(true);
    expect(result.canManageSubscription).toBe(true);
    expect(result.canServiceExistingBooking).toBe(false);
    expect(result.canSendTransactionalReminder).toBe(false);
  });

  it("fails an enrolled malformed trial date closed without hiding data", () => {
    const result = resolveTenantEntitlements({
      ...enrolled,
      trial_ends_at: "not-a-date",
    });
    expect(result.state).toBe("trial_read_only");
    expect(result.canViewOperationalData).toBe(true);
    expect(result.canCreateNewBooking).toBe(false);
  });

  it("does not change existing salons before deliberate enrollment", () => {
    const result = resolveTenantEntitlements({
      ...enrolled,
      feature_flags: {},
    });
    expect(result.state).toBe("legacy");
    expect(result.policyEnforced).toBe(false);
    expect(result.canCreateNewBooking).toBe(true);
  });

  it("does not enroll a tenant from a string-shaped policy marker", () => {
    const result = resolveTenantEntitlements({
      ...enrolled,
      feature_flags: { [TRIAL_EXPIRY_POLICY_FLAG]: "1" },
    });
    expect(result.state).toBe("legacy");
    expect(result.policyEnforced).toBe(false);
  });

  it("keeps archived and locked tenants closed even before enrollment", () => {
    for (const row of [
      { ...enrolled, feature_flags: {}, archived_at: "2026-09-15T00:00:00.000Z" },
      {
        ...enrolled,
        feature_flags: {},
        superadmin_locked_at: "2026-09-15T00:00:00.000Z",
      },
    ]) {
      const result = resolveTenantEntitlements(row);
      expect(result.canCreateNewBooking).toBe(false);
      expect(result.canRunAutonomousAi).toBe(false);
    }
  });

  it("keeps active and past-due recovery tenants operational", () => {
    for (const subscription_status of ["active", "past_due"]) {
      const result = resolveTenantEntitlements({
        ...enrolled,
        subscription_status,
      });
      expect(result.canCreateNewBooking).toBe(true);
    }
  });

  it("fails canceled, unknown, archived and locked tenants closed for mutations", () => {
    const rows = [
      { ...enrolled, subscription_status: "canceled" },
      { ...enrolled, subscription_status: "unexpected" },
      { ...enrolled, archived_at: "2026-09-15T00:00:00.000Z" },
      { ...enrolled, superadmin_locked_at: "2026-09-15T00:00:00.000Z" },
    ];
    for (const row of rows) {
      const result = resolveTenantEntitlements(row);
      expect(result.canCreateNewBooking).toBe(false);
      expect(result.canRunAutonomousAi).toBe(false);
    }
  });

  it("adds the policy receipt without discarding existing feature flags", () => {
    expect(withTrialExpiryPolicy({ group_booking_enabled: true })).toEqual({
      group_booking_enabled: true,
      [TRIAL_EXPIRY_POLICY_FLAG]: 1,
    });
  });
});
