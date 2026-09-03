import { describe, expect, it } from "vitest";

import type {
  TurnIqCandidateInput,
  TurnIqHandoffDecisionInput,
} from "@/shared/turniq/contracts";
import { salonATurnPolicyFixture } from "@/shared/turniq/fixtures/salonA";
import { decideTurnIqMultiTechnicianHandoff } from "@/shared/turniq/multiTechnicianHandoffEngine";

function candidate(position: number): TurnIqCandidateInput {
  const staffId = `invariant-tech-${String(position).padStart(2, "0")}`;
  return {
    staffId,
    displayName: `Invariant Tech ${position}`,
    stableStaffId: staffId,
    checkInSessionId: `invariant-shift-${position}`,
    checkedInAt: `2026-09-02T15:${String(position).padStart(2, "0")}:00.000Z`,
    queuePosition: position,
    checkedIn: true,
    active: true,
    busy: false,
    approvedBreak: false,
    temporaryHold: false,
    refusalPenaltyActive: false,
    manualSafetyHold: false,
    capabilityDataComplete: true,
    capableServiceIds: ["manicure", "pedicure", "massage"],
    nextAppointmentStartsAt: null,
    serviceCreditSinceCheckInCents: (position - 1) * 500,
    fairnessBaselineCents: 6_000,
  };
}

function fixture(): TurnIqHandoffDecisionInput {
  const candidates = Array.from({ length: 6 }, (_, index) => candidate(index + 1));
  const line = (
    segmentId: string,
    serviceId: string,
    startsAt: string,
    releasesAt: string,
    price: number,
    resourceId: string | null,
  ) => ({
    segmentId,
    serviceLines: [
      {
        lineId: `${segmentId}-line`,
        serviceId,
        serviceName: serviceId,
        catalogPriceCents: price,
        permittedAddonCents: 0,
        durationMinutes: (Date.parse(releasesAt) - Date.parse(startsAt)) / 60_000,
        bufferMinutes: 0,
        requiredResourceTypeIds: resourceId ? ["pedicure-chair"] : [],
      },
    ],
    startsAt,
    releasesAt,
    resourceId,
    requestedTechnician: null,
  });
  return {
    policy: structuredClone(salonATurnPolicyFixture),
    request: {
      requestId: "handoff-invariant-request",
      salonId: salonATurnPolicyFixture.salonId,
      bookingId: "handoff-invariant-booking",
      segments: [
        line(
          "segment-a",
          "manicure",
          "2026-09-02T18:00:00.000Z",
          "2026-09-02T18:45:00.000Z",
          4_000,
          "shared-chair",
        ),
        line(
          "segment-b",
          "pedicure",
          "2026-09-02T18:00:00.000Z",
          "2026-09-02T19:00:00.000Z",
          6_000,
          "shared-chair",
        ),
        line(
          "segment-c",
          "massage",
          "2026-09-02T19:00:00.000Z",
          "2026-09-02T19:30:00.000Z",
          3_000,
          null,
        ),
        line(
          "segment-d",
          "manicure",
          "2026-09-02T19:30:00.000Z",
          "2026-09-02T20:00:00.000Z",
          3_500,
          null,
        ),
      ],
    },
    snapshot: {
      snapshotVersion: "handoff-invariant-v1",
      capturedAt: "2026-09-02T17:59:00.000Z",
      businessDate: "2026-09-02",
      candidates,
      staffAvailability: candidates.map((item) => ({
        staffId: item.staffId,
        availableAt: "2026-09-02T18:00:00.000Z",
        busyWindows: [],
      })),
      resources: [
        {
          resourceId: "shared-chair",
          resourceTypeId: "pedicure-chair",
          available: true,
          availableAt: "2026-09-02T18:00:00.000Z",
          sameCustomerParallelCapacity: 2,
          policyFingerprint: "shared-resource-policy-v1",
        },
      ],
    },
  };
}

function seededShuffle<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const swapIndex = state % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function overlaps(
  left: { startsAt: string; releasesAt: string },
  right: { startsAt: string; releasesAt: string },
): boolean {
  return Date.parse(left.startsAt) < Date.parse(right.releasesAt) &&
    Date.parse(right.startsAt) < Date.parse(left.releasesAt);
}

describe("TurnIQ multi-technician handoff invariants", () => {
  it("preserves complete coverage, non-overlapping staff and exact per-tech credit across permutations", async () => {
    const baseline = await decideTurnIqMultiTechnicianHandoff(fixture());
    const expectedTotal = fixture().request.segments.reduce(
      (total, segment) =>
        total + segment.serviceLines.reduce(
          (lineTotal, line) =>
            lineTotal + line.catalogPriceCents + line.permittedAddonCents,
          0,
        ),
      0,
    );

    for (let seed = 1; seed <= 30; seed += 1) {
      const input = fixture();
      input.snapshot.candidates = seededShuffle(input.snapshot.candidates, seed);
      input.snapshot.staffAvailability = seededShuffle(
        input.snapshot.staffAvailability,
        seed + 100,
      );
      input.snapshot.resources = seededShuffle(input.snapshot.resources, seed + 200);
      const decision = await decideTurnIqMultiTechnicianHandoff(input);

      expect(decision.fingerprint).toBe(baseline.fingerprint);
      expect(decision.assignments).toEqual(baseline.assignments);
      expect(decision.assignments).toHaveLength(input.request.segments.length);
      expect(
        decision.performers.reduce(
          (total, performer) => total + performer.opportunityCreditCents,
          0,
        ),
      ).toBe(expectedTotal);
      expect(
        decision.performers.every(
          (performer) => performer.turnsToConsumeOnAttributedWorkCompletion === 1,
        ),
      ).toBe(true);

      for (const assignment of decision.assignments) {
        const conflicts = decision.assignments.filter(
          (other) =>
            other.segmentId !== assignment.segmentId &&
            other.staffId === assignment.staffId &&
            overlaps(assignment, other),
        );
        expect(conflicts).toEqual([]);
      }
    }
  });
});
