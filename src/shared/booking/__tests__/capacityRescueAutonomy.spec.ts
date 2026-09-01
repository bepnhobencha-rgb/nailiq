import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { classifyCapacityRescueAutonomy } from "@/shared/booking/capacityRescueAutonomy";

describe("Smart Capacity Rescue autonomy boundary", () => {
  it("keeps a waiting individual in the safe exact-slot invitation lane", () => {
    expect(
      classifyCapacityRescueAutonomy({
        requestKind: "individual",
        status: "waiting",
      }),
    ).toEqual({
      lane: "auto_safe",
      reason: "watching_for_exact_slot",
      canUseSingleSlotInvitation: true,
      canShowApprovalAction: false,
    });
  });

  it("never sends a group request through the single-slot worker", () => {
    expect(
      classifyCapacityRescueAutonomy({
        requestKind: "group",
        status: "review_required",
      }),
    ).toEqual({
      lane: "approval_required",
      reason: "exact_plan_required",
      canUseSingleSlotInvitation: false,
      canShowApprovalAction: false,
    });
  });

  it("unlocks approval only when a complex executable plan is proven", () => {
    const decision = classifyCapacityRescueAutonomy({
      requestKind: "sequence",
      status: "review_required",
      hasExecutablePlan: true,
    });
    expect(decision.lane).toBe("approval_required");
    expect(decision.canUseSingleSlotInvitation).toBe(false);
    expect(decision.canShowApprovalAction).toBe(true);
  });

  it("routes an invalid complex-state combination to a human exception", () => {
    expect(
      classifyCapacityRescueAutonomy({
        requestKind: "group",
        status: "waiting",
        hasExecutablePlan: true,
      }),
    ).toEqual({
      lane: "human_exception",
      reason: "unsafe_state_combination",
      canUseSingleSlotInvitation: false,
      canShowApprovalAction: false,
    });
  });

  it("keeps claimed individual offers visible until the final booking commit", () => {
    const decision = classifyCapacityRescueAutonomy({
      requestKind: "individual",
      status: "claimed",
    });
    expect(decision).toMatchObject({
      lane: "human_exception",
      reason: "booking_commit_pending",
      canUseSingleSlotInvitation: false,
    });
  });

  it("fails closed in the UI, server action and database for complex legacy drift", () => {
    const root = process.cwd();
    const panel = readFileSync(
      resolve(root, "src/components/receptionist/OnlineWaitlistPanel.tsx"),
      "utf8",
    );
    const actions = readFileSync(
      resolve(root, "src/shared/dashboard/receptionistActions.ts"),
      "utf8",
    );
    const migration = readFileSync(
      resolve(
        root,
        "supabase/migrations/20260901013550_guard_complex_capacity_rescue_autonomy.sql",
      ),
      "utf8",
    );

    expect(panel).toContain('autonomy.lane !== "auto_safe"');
    expect(actions).toContain('requestKind !== "individual"');
    expect(actions).toContain('error: "waitlist_plan_required"');
    expect(migration).toContain("complex_request_requires_plan");
    expect(migration).toContain("BEFORE INSERT OR UPDATE OF request_kind, status");
    expect(migration).toContain("REVOKE ALL ON FUNCTION");
    expect(migration).not.toContain("GRANT EXECUTE ON FUNCTION public.guard_complex_capacity_rescue_autonomy()\n  TO anon");
  });
});
