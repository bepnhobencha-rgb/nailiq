import { describe, expect, it } from "vitest";

import type { TurnIqDecisionInput } from "@/shared/turniq/contracts";
import { salonASingleCustomerInputFixture } from "@/shared/turniq/fixtures/salonA";
import { decideSingleCustomer } from "@/shared/turniq/singleCustomerEngine";
import {
  compareTurnIqShadowDecision,
  runTurnIqReplay,
  summarizeTurnIqShadowMetrics,
  type TurnIqActualAssignment,
} from "@/shared/turniq/shadowReplay";

function replayCase(): TurnIqDecisionInput {
  const input = structuredClone(salonASingleCustomerInputFixture);
  input.request.requestedTechnician = null;
  input.snapshot.candidates = [
    {
      ...input.snapshot.candidates[0],
      staffId: "staff-a",
      stableStaffId: "staff-a",
      displayName: "Tech A",
      queuePosition: 2,
      serviceCreditSinceCheckInCents: 0,
      fairnessBaselineCents: 0,
    },
    {
      ...input.snapshot.candidates[0],
      staffId: "staff-b",
      stableStaffId: "staff-b",
      displayName: "Tech B",
      queuePosition: 1,
      serviceCreditSinceCheckInCents: 2_000,
      fairnessBaselineCents: 0,
    },
  ];
  input.snapshot.snapshotVersion = "replay-snapshot-1";
  return input;
}

const actual: TurnIqActualAssignment = {
  assignedStaffId: "staff-b",
  customerAddedAt: "2026-09-02T18:00:00.000Z",
  assignedAt: "2026-09-02T18:00:12.000Z",
  ownerIntervened: false,
  divergenceReason: null,
};

describe("TurnIQ shadow comparison and replay", () => {
  it("distinguishes match, explained divergence, and ineligible actual assignee", async () => {
    const decision = await decideSingleCustomer(replayCase());
    const matched = compareTurnIqShadowDecision(decision, actual);
    expect(matched).toMatchObject({
      outcome: "matched_recommendation",
      assignmentLatencySeconds: 12,
    });

    const explained = compareTurnIqShadowDecision(decision, {
      ...actual,
      assignedStaffId: "staff-a",
      divergenceReason: "customer_rejected_recommendation",
    });
    expect(explained.outcome).toBe("explained_divergence");

    const ineligibleInput = replayCase();
    ineligibleInput.snapshot.candidates[0].busy = true;
    const ineligibleDecision = await decideSingleCustomer(ineligibleInput);
    const ineligible = compareTurnIqShadowDecision(ineligibleDecision, {
      ...actual,
      assignedStaffId: "staff-a",
      divergenceReason: "manager_override",
    });
    expect(ineligible.outcome).toBe("actual_assignee_ineligible");
  });

  it("calculates deterministic baseline metrics without treating pending as rejection", async () => {
    const decision = await decideSingleCustomer(replayCase());
    const comparisons = [
      compareTurnIqShadowDecision(decision, actual),
      compareTurnIqShadowDecision(decision, {
        assignedStaffId: null,
        customerAddedAt: "2026-09-02T18:10:00.000Z",
        assignedAt: null,
        ownerIntervened: false,
        divergenceReason: null,
      }),
      compareTurnIqShadowDecision(decision, {
        ...actual,
        assignedStaffId: "staff-a",
        assignedAt: "2026-09-02T18:00:20.000Z",
        ownerIntervened: true,
        divergenceReason: "manager_override",
      }),
    ];
    expect(summarizeTurnIqShadowMetrics(comparisons)).toEqual({
      total: 3,
      matched: 1,
      pending: 1,
      noSafeRecommendation: 0,
      explainedDivergence: 1,
      unexplainedDivergence: 0,
      actualAssigneeIneligible: 0,
      ownerInterventions: 1,
      recommendationAcceptanceBasisPoints: 5_000,
      averageAssignmentLatencySeconds: 16,
      medianAssignmentLatencySeconds: 16,
    });
  });

  it("replays another fairness band deterministically without mutating history", async () => {
    const historical = replayCase();
    const before = structuredClone(historical);
    const currentPolicy = structuredClone(historical.policy);
    const proposedPolicy = {
      ...structuredClone(historical.policy),
      policyId: "turniq-salon-a-policy-proposed",
      version: 2,
      fairnessBandCents: 0,
    };
    const replayInput = {
      runId: "replay-run-1",
      salonId: historical.request.salonId,
      createdAt: "2026-09-03T01:00:00.000Z",
      currentPolicy,
      proposedPolicy,
      cases: [
        { caseId: "case-b", decisionInput: historical, actualAssignment: actual },
        {
          caseId: "case-a",
          decisionInput: structuredClone(historical),
          actualAssignment: actual,
        },
      ],
    };
    const first = await runTurnIqReplay(replayInput);
    const second = await runTurnIqReplay({
      ...replayInput,
      cases: [...replayInput.cases].reverse(),
    });

    expect(first.cases.map((entry) => entry.caseId)).toEqual(["case-a", "case-b"]);
    expect(first.cases[0]).toMatchObject({
      currentRecommendedStaffId: "staff-b",
      proposedRecommendedStaffId: "staff-a",
      recommendationChanged: true,
    });
    expect(first.currentMetrics.recommendationAcceptanceBasisPoints).toBe(10_000);
    expect(first.proposedMetrics.recommendationAcceptanceBasisPoints).toBe(0);
    expect(second.resultFingerprint).toBe(first.resultFingerprint);
    expect(historical).toEqual(before);
    expect(first.readOnly).toBe(true);
  });

  it("rejects incomplete or temporally impossible actual assignments", async () => {
    const decision = await decideSingleCustomer(replayCase());
    expect(() =>
      compareTurnIqShadowDecision(decision, {
        ...actual,
        assignedAt: null,
      }),
    ).toThrow("turniq_actual_assignment_incomplete");
    expect(() =>
      compareTurnIqShadowDecision(decision, {
        ...actual,
        assignedAt: "2026-09-02T17:59:59.000Z",
      }),
    ).toThrow("turniq_actual_assignment_before_customer_added");
  });
});
