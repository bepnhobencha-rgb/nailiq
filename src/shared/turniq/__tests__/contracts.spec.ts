import { describe, expect, it } from "vitest";

import {
  assertTurnIqCents,
  requestedTechTrustLabel,
  toPrivacySafeCandidateTrace,
  toTurnIqDecisionView,
  TURNIQ_FEATURE_FLAG,
  TURNIQ_GROUP_OBJECTIVE_ORDER,
  type TurnIqCandidateTrace,
  type TurnIqDecisionRecord,
} from "@/shared/turniq/contracts";
import {
  salonACandidateFixture,
  salonASingleCustomerInputFixture,
  salonATurnPolicyFixture,
} from "@/shared/turniq/fixtures/salonA";

describe("TurnIQ M0 contracts", () => {
  it("keeps the per-salon release key explicit and default-off ready", () => {
    expect(TURNIQ_FEATURE_FLAG).toBe("turniq_trust_engine_enabled");
  });

  it("seeds twelve technicians in deterministic check-in order", () => {
    expect(salonACandidateFixture).toHaveLength(12);
    expect(salonACandidateFixture.map((staff) => staff.queuePosition)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(salonACandidateFixture.map((staff) => staff.stableStaffId)).toEqual(
      [...salonACandidateFixture]
        .map((staff) => staff.stableStaffId)
        .sort(),
    );
  });

  it("gives the late technician a non-cash median baseline", () => {
    const lateTechnician = salonACandidateFixture.at(-1);
    expect(lateTechnician?.serviceCreditSinceCheckInCents).toBe(0);
    expect(lateTechnician?.fairnessBaselineCents).toBeGreaterThan(0);
    expect(lateTechnician?.queuePosition).toBe(12);
  });

  it("keeps fairness money in non-negative integer cents", () => {
    assertTurnIqCents(
      salonATurnPolicyFixture.fairnessBandCents,
      "fairnessBandCents",
    );
    for (const candidate of salonACandidateFixture) {
      assertTurnIqCents(
        candidate.serviceCreditSinceCheckInCents,
        "serviceCreditSinceCheckInCents",
      );
      assertTurnIqCents(
        candidate.fairnessBaselineCents,
        "fairnessBaselineCents",
      );
    }
    expect(() => assertTurnIqCents(20.5, "invalidCents")).toThrow(
      "invalidCents must be a non-negative integer in cents",
    );
  });

  it("does not call a staff-entered request independently verified", () => {
    const request = salonASingleCustomerInputFixture.request.requestedTechnician;
    expect(request?.source).toBe("staff_entered");
    expect(requestedTechTrustLabel("staff_entered")).toBe(
      "customer_claim_recorded",
    );
    expect(requestedTechTrustLabel("legacy_unknown")).toBe("legacy_unknown");
  });

  it("removes exact fairness credit from technician-safe traces", () => {
    const internal: TurnIqCandidateTrace = {
      staffId: "turniq-staff-01",
      displayName: "Tech 01",
      stableStaffId: "turniq-staff-01",
      eligible: true,
      reasonCodes: ["ELIGIBLE"],
      queuePosition: 1,
      fairnessCreditCents: 7_500,
      fairnessTier: 0,
      rank: 1,
    };
    expect(toPrivacySafeCandidateTrace(internal)).toEqual({
      staffId: "turniq-staff-01",
      displayName: "Tech 01",
      eligible: true,
      reasonCodes: ["ELIGIBLE"],
      queuePosition: 1,
      rank: 1,
    });
  });

  it("keeps the authorized internal trace out of the default client view", () => {
    const trace: TurnIqCandidateTrace = {
      staffId: "turniq-staff-01",
      displayName: "Tech 01",
      stableStaffId: "turniq-staff-01",
      eligible: true,
      reasonCodes: ["ELIGIBLE"],
      queuePosition: 1,
      fairnessCreditCents: 7_500,
      fairnessTier: 0,
      rank: 1,
    };
    const record: TurnIqDecisionRecord = {
      decisionId: "turniq-decision-001",
      salonId: "turniq-salon-a",
      recommendedStaffId: "turniq-staff-01",
      policyId: salonATurnPolicyFixture.policyId,
      policyVersion: salonATurnPolicyFixture.version,
      snapshotVersion: "salon-a-2026-09-02-v1",
      decidedAt: "2026-09-02T18:00:00.000Z",
      fingerprint: "fixture-fingerprint",
      decisionReasonCodes: ["ELIGIBLE"],
      candidates: [trace],
      privacySafeExplanation: "Recommended staff is available and qualified.",
      internalTrace: {
        orderedCandidates: [trace],
        fairnessBandCents: 2_000,
        requestTrustLabel: null,
      },
    };
    const view = toTurnIqDecisionView(record);
    expect(view).not.toHaveProperty("internalTrace");
    expect(view.candidates[0]).not.toHaveProperty("fairnessCreditCents");
    expect(JSON.stringify(view)).not.toContain("7500");
  });

  it("locks the group objective order before a solver is implemented", () => {
    expect(TURNIQ_GROUP_OBJECTIVE_ORDER).toEqual([
      "feasibility",
      "requested_technician",
      "appointment_safety",
      "customer_wait",
      "fairness_cost",
      "stable_tie_break",
    ]);
  });
});
