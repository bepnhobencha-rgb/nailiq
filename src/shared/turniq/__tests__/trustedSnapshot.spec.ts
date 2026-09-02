import { describe, expect, it } from "vitest";

import type { TurnIqPolicyVersion } from "@/shared/turniq/contracts";
import { decideSingleCustomer } from "@/shared/turniq/singleCustomerEngine";
import {
  buildTrustedTurnIqDecisionInput,
  type TurnIqTrustedSnapshotSource,
} from "@/shared/turniq/trustedSnapshot";

const policy: TurnIqPolicyVersion = {
  policyId: "policy-1",
  salonId: "salon-a",
  version: 1,
  name: "Salon A pilot",
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

function source(): TurnIqTrustedSnapshotSource {
  return {
    salonId: "salon-a",
    resourcesEnabled: true,
    capturedAt: "2026-09-02T17:00:00.000Z",
    businessDate: "2026-09-02",
    policy: structuredClone(policy),
    booking: {
      id: "booking-target",
      salonId: "salon-a",
      serviceId: "classic-pedicure",
      addonServiceId: null,
      staffId: null,
      staffRequestedByClient: false,
      createdAt: "2026-09-02T16:55:00.000Z",
      startAt: "2026-09-02T17:15:00.000Z",
      endAt: "2026-09-02T18:15:00.000Z",
      status: "waiting",
      scheduleModel: "single",
      partySize: 1,
      groupId: null,
      resourceId: null,
      hasBookingAddonRows: false,
    },
    services: [
      {
        id: "classic-pedicure",
        name: "Classic Pedicure",
        priceCents: 5_000,
        durationMinutes: 50,
        bufferMinutes: 10,
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
        policyVersionId: "policy-1",
        staffId: "staff-a",
        businessDate: "2026-09-02",
        checkedInAt: "2026-09-02T15:00:00.000Z",
        state: "active",
        queuePosition: 1,
        fairnessBaselineCents: 4_000,
        serviceCreditSinceCheckInCents: 2_000,
        stateVersion: 1,
      },
      {
        id: "shift-b",
        policyVersionId: "policy-1",
        staffId: "staff-b",
        businessDate: "2026-09-02",
        checkedInAt: "2026-09-02T15:05:00.000Z",
        state: "active",
        queuePosition: 2,
        fairnessBaselineCents: 4_000,
        serviceCreditSinceCheckInCents: 0,
        stateVersion: 1,
      },
      {
        id: "shift-c",
        policyVersionId: "policy-1",
        staffId: "staff-c",
        businessDate: "2026-09-02",
        checkedInAt: "2026-09-02T15:10:00.000Z",
        state: "active",
        queuePosition: 3,
        fairnessBaselineCents: 4_000,
        serviceCreditSinceCheckInCents: 0,
        stateVersion: 1,
      },
    ],
    capabilities: [
      { staffId: "staff-a", serviceId: "classic-pedicure" },
      { staffId: "staff-b", serviceId: "classic-pedicure" },
      { staffId: "staff-c", serviceId: "classic-pedicure" },
    ],
    occupiedBookings: [
      {
        id: "staff-b-conflict",
        staffId: "staff-b",
        resourceId: "chair-2",
        startAt: "2026-09-02T17:00:00.000Z",
        endAt: "2026-09-02T18:00:00.000Z",
        status: "in_progress",
      },
      {
        id: "staff-c-next",
        staffId: "staff-c",
        resourceId: "chair-3",
        startAt: "2026-09-02T18:00:00.000Z",
        endAt: "2026-09-02T19:00:00.000Z",
        status: "confirmed",
      },
    ],
    resources: [
      { id: "chair-1", kind: "chair", active: true },
      { id: "chair-2", kind: "chair", active: true },
      { id: "chair-3", kind: "chair", active: true },
    ],
  };
}

describe("TurnIQ trusted snapshot", () => {
  it("derives busy, appointment-gap and resource truth before ranking", async () => {
    const built = await buildTrustedTurnIqDecisionInput(source());
    const decision = await decideSingleCustomer(built.decisionInput);

    expect(built.resourceId).toBe("chair-1");
    expect(built.confirmationSnapshot).toMatchObject({
      version: 1,
      businessDate: "2026-09-02",
      resourcesEnabled: true,
      booking: {
        bookingId: "booking-target",
        serviceId: "classic-pedicure",
        resourceId: "chair-1",
      },
      shifts: [
        { shiftSessionId: "shift-a", staffId: "staff-a", stateVersion: 1 },
        { shiftSessionId: "shift-b", staffId: "staff-b", stateVersion: 1 },
        { shiftSessionId: "shift-c", staffId: "staff-c", stateVersion: 1 },
      ],
    });
    expect(built.confirmationSnapshot.capacity).toHaveLength(2);
    expect(decision.recommendedStaffId).toBe("staff-a");
    expect(
      decision.candidates.find((candidate) => candidate.staffId === "staff-b")
        ?.reasonCodes,
    ).toContain("CURRENTLY_BUSY");
    expect(
      decision.candidates.find((candidate) => candidate.staffId === "staff-c")
        ?.reasonCodes,
    ).toContain("INSUFFICIENT_APPOINTMENT_GAP");
  });

  it("fails capability truth closed when the salon whitelist could not be loaded", async () => {
    const value = source();
    value.capabilities = null;
    const built = await buildTrustedTurnIqDecisionInput(value);
    const decision = await decideSingleCustomer(built.decisionInput);
    expect(decision.recommendedStaffId).toBeNull();
    expect(decision.candidates.every((candidate) =>
      candidate.reasonCodes.includes("CAPABILITY_DATA_INCOMPLETE")
    )).toBe(true);
  });

  it("preserves an old requested-tech hint as unverified and never grants precedence", async () => {
    const value = source();
    value.booking.staffId = "staff-c";
    value.booking.staffRequestedByClient = true;
    value.occupiedBookings = [];
    const built = await buildTrustedTurnIqDecisionInput(value);
    const decision = await decideSingleCustomer(built.decisionInput);
    expect(built.decisionInput.request.requestedTechnician?.source).toBe(
      "legacy_unknown",
    );
    expect(decision.decisionReasonCodes).toContain(
      "UNVERIFIED_LEGACY_REQUEST_IGNORED",
    );
    expect(decision.recommendedStaffId).toBe("staff-a");
  });

  it("requires legacy add-on capability and keeps its credit separate from the main catalog price", async () => {
    const value = source();
    value.booking.addonServiceId = "gel-addon";
    value.services = [
      ...value.services,
      {
        id: "gel-addon",
        name: "Gel add-on",
        priceCents: 1_500,
        durationMinutes: 15,
        bufferMinutes: 0,
        isAddon: true,
        resourceRequirementMode: "specific",
        requiredResourceKinds: ["chair"],
      },
    ];
    value.capabilities = [
      ...(value.capabilities ?? []),
      { staffId: "staff-a", serviceId: "gel-addon" },
    ];
    const built = await buildTrustedTurnIqDecisionInput(value);
    expect(built.decisionInput.request.serviceLines).toHaveLength(2);
    expect(built.decisionInput.request.serviceLines[1]).toMatchObject({
      serviceId: "gel-addon",
      catalogPriceCents: 0,
      permittedAddonCents: 1_500,
    });
    const decision = await decideSingleCustomer(built.decisionInput);
    expect(decision.recommendedStaffId).toBe("staff-a");
    expect(
      decision.candidates.find((candidate) => candidate.staffId === "staff-c")
        ?.reasonCodes,
    ).toContain("SKILL_MISMATCH");
  });

  it("rejects group, segmented, addon-ledger and ambiguous resource inputs", async () => {
    const group = source();
    group.booking.partySize = 2;
    await expect(buildTrustedTurnIqDecisionInput(group)).rejects.toMatchObject({
      code: "turniq_trusted_single_booking_required",
    });

    const addonRows = source();
    addonRows.booking.hasBookingAddonRows = true;
    await expect(buildTrustedTurnIqDecisionInput(addonRows)).rejects.toMatchObject({
      code: "turniq_booking_addon_ledger_not_supported",
    });

    const alternatives = source();
    alternatives.services = alternatives.services.map((service) => ({
      ...service,
      requiredResourceKinds: ["chair", "bed"],
    }));
    await expect(buildTrustedTurnIqDecisionInput(alternatives)).rejects.toMatchObject({
      code: "turniq_resource_alternatives_unsupported",
    });
  });

  it("keeps customer PII outside the snapshot contract and fingerprint", async () => {
    const value = source();
    const built = await buildTrustedTurnIqDecisionInput(value);
    const keys = new Set<string>();
    JSON.stringify(built, (key, nested) => {
      if (key) keys.add(key);
      return nested;
    });
    expect(keys).not.toContain("clientName");
    expect(keys).not.toContain("clientPhone");
    expect(keys).not.toContain("clientEmail");
    expect(keys).not.toContain("clientNotes");
    expect(keys).not.toContain("tipCents");
    expect(keys).not.toContain("internalDecisionTrace");
    expect(built.decisionInput.snapshot.snapshotVersion).toMatch(/^[0-9a-f]{64}$/);
  });
});
