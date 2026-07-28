import { describe, expect, it } from "vitest";

import { canRunAutonomousAiForTenant } from "../tenantExecutionBoundary";

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
