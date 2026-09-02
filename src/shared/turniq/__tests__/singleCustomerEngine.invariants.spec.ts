import { describe, expect, it } from "vitest";

import {
  toTurnIqDecisionView,
  type TurnIqCandidateInput,
  type TurnIqDecisionInput,
} from "@/shared/turniq/contracts";
import { salonASingleCustomerInputFixture } from "@/shared/turniq/fixtures/salonA";
import { decideSingleCustomer } from "@/shared/turniq/singleCustomerEngine";

function generatedInput(seed: number): TurnIqDecisionInput {
  const input = structuredClone(salonASingleCustomerInputFixture);
  input.request.requestedTechnician = null;
  input.snapshot.candidates = Array.from({ length: 12 }, (_, index) => {
    const staffNumber = index + 1;
    const staffId = `generated-${String(staffNumber).padStart(2, "0")}`;
    const credit = (seed * 997 + staffNumber * 1_813) % 20_001;
    const candidate: TurnIqCandidateInput = {
      staffId,
      displayName: `Generated ${staffNumber}`,
      stableStaffId: staffId,
      checkInSessionId: `session-${seed}-${staffNumber}`,
      checkedInAt: "2026-09-02T15:00:00.000Z",
      queuePosition: ((staffNumber * 7 + seed) % 12) + 1,
      checkedIn: true,
      active: true,
      busy: false,
      approvedBreak: false,
      temporaryHold: false,
      refusalPenaltyActive: false,
      manualSafetyHold: false,
      capabilityDataComplete: true,
      capableServiceIds: ["deluxe-pedicure"],
      nextAppointmentStartsAt: null,
      serviceCreditSinceCheckInCents: credit,
      fairnessBaselineCents: 0,
    };
    return candidate;
  });
  input.snapshot.snapshotVersion = `generated-${seed}`;
  return input;
}

describe("TurnIQ single-customer invariants", () => {
  it("is permutation-invariant and never selects an ineligible candidate", async () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const input = generatedInput(seed);
      if (seed % 2 === 0) input.snapshot.candidates[seed % 12].busy = true;
      if (seed % 3 === 0) {
        input.snapshot.candidates[(seed + 1) % 12].capableServiceIds = [];
      }

      const reversed = structuredClone(input);
      reversed.snapshot.candidates = [...reversed.snapshot.candidates].reverse();
      const normalDecision = await decideSingleCustomer(input);
      const reversedDecision = await decideSingleCustomer(reversed);

      expect(reversedDecision.fingerprint).toBe(normalDecision.fingerprint);
      expect(reversedDecision.recommendedStaffId).toBe(
        normalDecision.recommendedStaffId,
      );
      const selected = normalDecision.candidates.find(
        (candidate) => candidate.staffId === normalDecision.recommendedStaffId,
      );
      expect(selected?.eligible).toBe(true);
      expect(selected?.rank).toBe(1);
      expect(
        normalDecision.candidates
          .filter((candidate) => candidate.eligible)
          .map((candidate) => candidate.rank)
          .sort((left, right) => Number(left) - Number(right)),
      ).toEqual(
        Array.from(
          {
            length: normalDecision.candidates.filter(
              (candidate) => candidate.eligible,
            ).length,
          },
          (_, index) => index + 1,
        ),
      );

      const clientJson = JSON.stringify(toTurnIqDecisionView(normalDecision));
      expect(clientJson).not.toContain("fairnessCreditCents");
      expect(clientJson).not.toContain("fairnessTier");
      expect(clientJson).not.toContain("internalTrace");
    }
  });

  it("always honors an eligible sourced request and never an ineligible one", async () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const eligibleInput = generatedInput(seed);
      const requestedStaff = eligibleInput.snapshot.candidates[seed % 12];
      eligibleInput.request.requestedTechnician = {
        staffId: requestedStaff.staffId,
        source: "in_person",
        actorId: `checkin-actor-${seed}`,
        recordedAt: "2026-09-02T17:59:00.000Z",
      };
      expect(
        (await decideSingleCustomer(eligibleInput)).recommendedStaffId,
      ).toBe(requestedStaff.staffId);

      const ineligibleInput = structuredClone(eligibleInput);
      ineligibleInput.snapshot.candidates[seed % 12].approvedBreak = true;
      const fallback = await decideSingleCustomer(ineligibleInput);
      expect(fallback.recommendedStaffId).not.toBe(requestedStaff.staffId);
      expect(fallback.decisionReasonCodes).toContain(
        "REQUESTED_TECH_UNAVAILABLE",
      );
    }
  });

  it("uses salon-local business dates through spring-forward and fall-back", async () => {
    const cases = [
      {
        businessDate: "2026-03-08",
        requestedStartAt: "2026-03-08T10:30:00.000Z",
        capturedAt: "2026-03-08T10:29:00.000Z",
      },
      {
        businessDate: "2026-11-01",
        requestedStartAt: "2026-11-01T08:30:00.000Z",
        capturedAt: "2026-11-01T08:29:00.000Z",
      },
      {
        businessDate: "2026-11-01",
        requestedStartAt: "2026-11-01T09:30:00.000Z",
        capturedAt: "2026-11-01T09:29:00.000Z",
      },
    ] as const;

    for (const scenario of cases) {
      const input = generatedInput(1);
      input.policy.effectiveBusinessDate = scenario.businessDate;
      input.snapshot.businessDate = scenario.businessDate;
      input.snapshot.capturedAt = scenario.capturedAt;
      input.request.requestedStartAt = scenario.requestedStartAt;
      const decision = await decideSingleCustomer(input);
      expect(decision.recommendedStaffId).not.toBeNull();
      expect(decision.decisionReasonCodes).not.toContain("STALE_SNAPSHOT");
    }
  });
});
