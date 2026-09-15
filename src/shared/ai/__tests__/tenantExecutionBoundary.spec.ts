import { describe, expect, it } from "vitest";

import { canRunAutonomousAiForTenant } from "../tenantExecutionBoundary";
import { TRIAL_EXPIRY_POLICY_FLAG } from "@/shared/subscriptions/tenantEntitlements";

const operational = {
  archived_at: null,
  superadmin_locked_at: null,
};

describe("AI tenant execution boundary", () => {
  it.each(["active", "trialing", "past_due"])(
    "allows the operational subscription state %s",
    (subscription_status) => {
      expect(
        canRunAutonomousAiForTenant({
          ...operational,
          subscription_status,
        }),
      ).toBe(true);
    },
  );

  it("stops autonomous work for an enrolled expired trial", () => {
    expect(
      canRunAutonomousAiForTenant(
        {
          ...operational,
          subscription_status: "trialing",
          trial_ends_at: "2026-09-15T00:00:00.000Z",
          feature_flags: { [TRIAL_EXPIRY_POLICY_FLAG]: 1 },
        },
        new Date("2026-09-15T00:00:00.000Z"),
      ),
    ).toBe(false);
  });

  it.each([
    {
      archived_at: "2026-07-28T12:00:00.000Z",
      superadmin_locked_at: null,
      subscription_status: "active",
    },
    {
      archived_at: null,
      superadmin_locked_at: "2026-07-28T12:00:00.000Z",
      subscription_status: "active",
    },
    {
      ...operational,
      subscription_status: "canceled",
    },
    {
      ...operational,
      subscription_status: "unknown",
    },
    operational,
  ])("fails closed for a non-operational tenant %#", (state) => {
    expect(canRunAutonomousAiForTenant(state)).toBe(false);
  });
});
