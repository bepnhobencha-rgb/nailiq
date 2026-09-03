import { describe, expect, it } from "vitest";

import { salonATurnPolicyFixture } from "@/shared/turniq/fixtures/salonA";
import {
  buildTrustedTurnIqHandoffDecisionInput,
  type TurnIqTrustedHandoffSnapshotSource,
} from "@/shared/turniq/trustedHandoffSnapshot";

function source(): TurnIqTrustedHandoffSnapshotSource {
  return {
    salonId: salonATurnPolicyFixture.salonId,
    capturedAt: "2026-09-02T17:00:00.000Z",
    businessDate: "2026-09-02",
    policy: structuredClone(salonATurnPolicyFixture),
    booking: {
      id: "booking-1",
      salonId: salonATurnPolicyFixture.salonId,
      status: "confirmed",
      scheduleModel: "segments_v1",
    },
    segments: [
      {
        id: "segment-1",
        bookingId: "booking-1",
        position: 0,
        serviceId: "manicure",
        serviceName: "Manicure",
        staffId: "staff-1",
        resourceId: "chair-1",
        customerStartAt: "2026-09-02T18:00:00.000Z",
        customerEndAt: "2026-09-02T19:00:00.000Z",
        occupiedStartAt: "2026-09-02T18:00:00.000Z",
        occupiedEndAt: "2026-09-02T19:10:00.000Z",
        serviceDurationMinutes: 60,
        sequentialAddonMinutes: 0,
        trailingBufferMinutes: 10,
        originalServicePriceCents: 4_000,
        addonPreVoucherCents: 0,
        addonLines: [],
      },
      {
        id: "segment-2",
        bookingId: "booking-1",
        position: 1,
        serviceId: "pedicure",
        serviceName: "Pedicure",
        staffId: "staff-2",
        resourceId: "chair-1",
        customerStartAt: "2026-09-02T18:00:00.000Z",
        customerEndAt: "2026-09-02T19:00:00.000Z",
        occupiedStartAt: "2026-09-02T18:00:00.000Z",
        occupiedEndAt: "2026-09-02T19:10:00.000Z",
        serviceDurationMinutes: 60,
        sequentialAddonMinutes: 0,
        trailingBufferMinutes: 10,
        originalServicePriceCents: 6_000,
        addonPreVoucherCents: 1_000,
        addonLines: [
          { serviceId: "addon-1", name: "Massage", priceCents: 1_000, durationMinutes: 10 },
        ],
      },
    ],
    staff: [
      { id: "staff-1", name: "Mai", active: true },
      { id: "staff-2", name: "Linh", active: true },
    ],
    shifts: [
      {
        id: "shift-1",
        policyVersionId: salonATurnPolicyFixture.policyId,
        staffId: "staff-1",
        businessDate: "2026-09-02",
        checkedInAt: "2026-09-02T16:00:00.000Z",
        state: "active",
        queuePosition: 1,
        fairnessBaselineCents: 5_000,
        serviceCreditSinceCheckInCents: 0,
        stateVersion: 1,
      },
      {
        id: "shift-2",
        policyVersionId: salonATurnPolicyFixture.policyId,
        staffId: "staff-2",
        businessDate: "2026-09-02",
        checkedInAt: "2026-09-02T16:01:00.000Z",
        state: "active",
        queuePosition: 2,
        fairnessBaselineCents: 5_000,
        serviceCreditSinceCheckInCents: 0,
        stateVersion: 1,
      },
    ],
    capabilities: [
      { staffId: "staff-1", serviceId: "manicure" },
      { staffId: "staff-2", serviceId: "pedicure" },
      { staffId: "staff-2", serviceId: "addon-1" },
    ],
    occupiedBookings: [
      {
        id: "other-1",
        bookingId: "other-booking",
        staffId: "staff-1",
        resourceId: null,
        startAt: "2026-09-02T20:00:00.000Z",
        endAt: "2026-09-02T20:30:00.000Z",
        status: "confirmed",
      },
    ],
    resources: [
      { id: "chair-1", kind: "pedicure-chair", active: true, sameGuestParallelCapacity: 2 },
    ],
    parallelPolicies: [
      {
        id: "policy-pair-1",
        serviceAId: "manicure",
        serviceBId: "pedicure",
        resourceMode: "shared",
        active: true,
      },
    ],
  };
}

describe("trusted TurnIQ handoff snapshot", () => {
  it("derives capabilities, busy windows and resource policy evidence server-side", async () => {
    const trusted = await buildTrustedTurnIqHandoffDecisionInput(source());

    expect(trusted.decisionInput.request.segments[1].serviceLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serviceId: "pedicure", catalogPriceCents: 6_000 }),
        expect.objectContaining({ serviceId: "addon-1", permittedAddonCents: 1_000 }),
      ]),
    );
    expect(trusted.decisionInput.snapshot.staffAvailability[0].busyWindows).toEqual([
      {
        startsAt: "2026-09-02T20:00:00.000Z",
        releasesAt: "2026-09-02T20:30:00.000Z",
      },
    ]);
    expect(trusted.decisionInput.snapshot.resources[0]).toEqual(
      expect.objectContaining({ sameCustomerParallelCapacity: 2, available: true }),
    );
    expect(trusted.shiftSessionByStaffId.get("staff-2")).toBe("shift-2");
  });

  it("fails closed when overlapping services lack an active certified policy", async () => {
    const input = source();
    input.parallelPolicies = [];

    await expect(buildTrustedTurnIqHandoffDecisionInput(input)).rejects.toThrow(
      "turniq_handoff_parallel_policy_missing",
    );
  });

  it("accepts sequential customer time even when protective buffers overlap", async () => {
    const input = source();
    const segments = [...input.segments];
    segments[1] = {
      ...input.segments[1],
      customerStartAt: "2026-09-02T19:00:00.000Z",
      customerEndAt: "2026-09-02T20:00:00.000Z",
      occupiedStartAt: "2026-09-02T19:00:00.000Z",
      occupiedEndAt: "2026-09-02T20:10:00.000Z",
      resourceId: null,
    };
    segments[0] = {
      ...input.segments[0],
      occupiedEndAt: "2026-09-02T19:05:00.000Z",
      resourceId: null,
    };
    input.segments = segments;
    input.parallelPolicies = [];

    await expect(buildTrustedTurnIqHandoffDecisionInput(input)).resolves.toBeDefined();
  });
});
