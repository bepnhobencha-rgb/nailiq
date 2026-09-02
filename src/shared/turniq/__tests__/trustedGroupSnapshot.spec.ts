import { describe, expect, it } from "vitest";

import type { TurnIqPolicyVersion } from "@/shared/turniq/contracts";
import { decideTurnIqGroup } from "@/shared/turniq/groupMatchingEngine";
import {
  buildTrustedTurnIqGroupDecisionInput,
  type TurnIqTrustedGroupSnapshotSource,
} from "@/shared/turniq/trustedGroupSnapshot";

const policy: TurnIqPolicyVersion = {
  policyId: "policy-group-1",
  salonId: "salon-a",
  version: 1,
  name: "Salon A group pilot",
  timezone: "America/Vancouver",
  effectiveBusinessDate: "2026-09-02",
  fairnessBandCents: 2_000,
  opportunityCreditStrategy:
    "catalog_plus_permitted_addons_before_tax_and_tip",
  lateArrivalBaselineStrategy: "median_eligible_team_credit_at_check_in",
  approvedBreakStrategy: "freeze_queue_position",
  unapprovedDepartureStrategy: "move_to_queue_end",
  unjustifiedRefusalStrategy: "move_to_queue_end",
  customerRejectionStrategy: "no_penalty",
  policyChangesDefaultToNextBusinessDay: true,
};

function source(): TurnIqTrustedGroupSnapshotSource {
  return {
    salonId: "salon-a",
    resourcesEnabled: true,
    capturedAt: "2026-09-02T16:00:00.000Z",
    businessDate: "2026-09-02",
    policy: structuredClone(policy),
    bookingGroupId: "group-1",
    bookings: [
      {
        id: "booking-a",
        salonId: "salon-a",
        groupId: "group-1",
        serviceId: "classic",
        addonServiceId: null,
        staffId: null,
        startAt: "2026-09-02T16:30:00.000Z",
        endAt: "2026-09-02T17:00:00.000Z",
        status: "pending",
        scheduleModel: "single",
        resourceId: null,
        hasBookingAddonRows: false,
        hasServiceSegments: false,
      },
      {
        id: "booking-b",
        salonId: "salon-a",
        groupId: "group-1",
        serviceId: "classic",
        addonServiceId: null,
        staffId: null,
        startAt: "2026-09-02T16:30:00.000Z",
        endAt: "2026-09-02T17:00:00.000Z",
        status: "waiting",
        scheduleModel: "single",
        resourceId: null,
        hasBookingAddonRows: false,
        hasServiceSegments: false,
      },
    ],
    services: [
      {
        id: "classic",
        name: "Classic Manicure",
        priceCents: 4_000,
        durationMinutes: 30,
        bufferMinutes: 0,
        isAddon: false,
        resourceRequirementMode: "specific",
        requiredResourceKinds: ["chair"],
      },
    ],
    staff: [
      { id: "staff-a", name: "Anh", active: true },
      { id: "staff-b", name: "Binh", active: true },
      { id: "staff-c", name: "Chi", active: true },
    ],
    shifts: [
      {
        id: "shift-a",
        policyVersionId: "policy-group-1",
        staffId: "staff-a",
        businessDate: "2026-09-02",
        checkedInAt: "2026-09-02T15:00:00.000Z",
        state: "active",
        queuePosition: 1,
        fairnessBaselineCents: 4_000,
        serviceCreditSinceCheckInCents: 0,
        stateVersion: 1,
      },
      {
        id: "shift-b",
        policyVersionId: "policy-group-1",
        staffId: "staff-b",
        businessDate: "2026-09-02",
        checkedInAt: "2026-09-02T15:01:00.000Z",
        state: "active",
        queuePosition: 2,
        fairnessBaselineCents: 4_000,
        serviceCreditSinceCheckInCents: 0,
        stateVersion: 1,
      },
      {
        id: "shift-c",
        policyVersionId: "policy-group-1",
        staffId: "staff-c",
        businessDate: "2026-09-02",
        checkedInAt: "2026-09-02T15:02:00.000Z",
        state: "approved_break",
        queuePosition: 3,
        fairnessBaselineCents: 4_000,
        serviceCreditSinceCheckInCents: 0,
        stateVersion: 1,
      },
    ],
    capabilities: [
      { staffId: "staff-a", serviceId: "classic" },
      { staffId: "staff-b", serviceId: "classic" },
      { staffId: "staff-c", serviceId: "classic" },
    ],
    occupiedBookings: [],
    resources: [
      { id: "chair-a", kind: "chair", active: true },
      { id: "chair-b", kind: "chair", active: true },
    ],
  };
}

describe("TurnIQ trusted group snapshot", () => {
  it("builds a complete deterministic plan from server-owned group facts", async () => {
    const built = await buildTrustedTurnIqGroupDecisionInput(source());
    const decision = await decideTurnIqGroup(built.decisionInput);

    expect(built.bookingIds).toEqual(["booking-a", "booking-b"]);
    expect(built.decisionInput.request.tasks.every(
      (task) => task.requestedTechnician === null,
    )).toBe(true);
    expect(decision.assignments).toEqual([
      expect.objectContaining({
        taskId: "booking-a",
        staffId: "staff-a",
        resourceIds: ["chair-a"],
        waitMinutes: 0,
      }),
      expect.objectContaining({
        taskId: "booking-b",
        staffId: "staff-b",
        resourceIds: ["chair-b"],
        waitMinutes: 0,
      }),
    ]);
    expect(decision.reasonCodes).toContain("GROUP_COMPLETE_MATCH");
  });

  it("derives future staff/resource availability without accepting browser choices", async () => {
    const value = source();
    value.occupiedBookings = [
      {
        id: "busy-a",
        staffId: "staff-a",
        resourceId: "chair-a",
        startAt: "2026-09-02T16:15:00.000Z",
        endAt: "2026-09-02T16:45:00.000Z",
        status: "confirmed",
      },
    ];
    const built = await buildTrustedTurnIqGroupDecisionInput(value);
    expect(built.decisionInput.snapshot.staffAvailability).toContainEqual({
      staffId: "staff-a",
      availableAt: "2026-09-02T16:45:00.000Z",
    });
    expect(built.decisionInput.snapshot.resources).toContainEqual({
      resourceId: "chair-a",
      resourceTypeId: "chair",
      available: true,
      availableAt: "2026-09-02T16:45:00.000Z",
    });
  });

  it("fails closed for mixed slots, preassignment and unsupported ledgers", async () => {
    const mixed = source();
    mixed.bookings[1].startAt = "2026-09-02T16:45:00.000Z";
    await expect(buildTrustedTurnIqGroupDecisionInput(mixed)).rejects.toMatchObject({
      code: "turniq_trusted_group_member_invalid",
    });

    const assigned = source();
    assigned.bookings[0].staffId = "staff-a";
    await expect(buildTrustedTurnIqGroupDecisionInput(assigned)).rejects.toMatchObject({
      code: "turniq_trusted_group_member_invalid",
    });

    const segmented = source();
    segmented.bookings[0].hasServiceSegments = true;
    await expect(buildTrustedTurnIqGroupDecisionInput(segmented)).rejects.toMatchObject({
      code: "turniq_group_service_segments_not_supported",
    });
  });

  it("keeps PII and financial business truth outside the contract", async () => {
    const built = await buildTrustedTurnIqGroupDecisionInput(source());
    const keys = new Set<string>();
    JSON.stringify(built, (key, value) => {
      if (key) keys.add(key);
      return value;
    });
    for (const forbidden of [
      "clientName",
      "clientPhone",
      "clientEmail",
      "tipCents",
      "taxCents",
      "actualRevenueCents",
      "internalDecisionTrace",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(built.decisionInput.snapshot.snapshotVersion).toMatch(/^[0-9a-f]{64}$/);
  });
});
