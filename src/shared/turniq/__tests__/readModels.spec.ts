import { describe, expect, it } from "vitest";

import {
  projectTurnIqExceptionInbox,
  projectTurnIqFairnessReceipt,
  projectTurnIqLiveBoard,
  projectTurnIqStaffView,
  type TurnIqAssignmentReadRow,
  type TurnIqFairnessReceiptReadRow,
  type TurnIqCorrectionReadRow,
  type TurnIqShiftReadRow,
  type TurnIqSwapReadRow,
} from "@/shared/turniq/readModels";

const shift: TurnIqShiftReadRow = {
  id: "shift-1",
  staffId: "staff-1",
  businessDate: "2026-09-02",
  state: "active",
  queuePosition: 1,
  turnsConsumed: 2,
  fairnessBaselineCents: 4_000,
  serviceCreditSinceCheckInCents: 6_000,
};

const assignment: TurnIqAssignmentReadRow = {
  id: "assignment-1",
  policyVersionId: "policy-1",
  bookingId: "booking-1",
  serviceId: "service-1",
  resourceId: "resource-1",
  recommendedStaffId: "staff-1",
  assignedStaffId: null,
  requestedStaffId: null,
  requestedTechSource: null,
  requestTrustLabel: null,
  decisionTimestamp: "2026-09-02T18:00:00.000Z",
  privacySafeExplanation: "Recommend Mai: available and safe before the next appointment.",
  eligibleCandidates: [{ staffId: "staff-1", reasonCodes: ["ELIGIBLE"], queuePosition: 1, rank: 1 }],
  skippedCandidates: [{ staffId: "staff-2", reasonCodes: ["SKILL_MISMATCH"], queuePosition: 2, rank: null }],
  refusalCategory: null,
  refusalReason: null,
  refusalOutcome: null,
  refusedAt: null,
  status: "recommended",
};

const receipt: TurnIqFairnessReceiptReadRow = {
  id: "receipt-1",
  policyVersionId: "policy-1",
  assignmentId: "assignment-1",
  recommendedStaffId: "staff-1",
  assignedStaffId: "staff-1",
  serviceId: "service-1",
  resourceId: "resource-1",
  requestedTechSource: "staff_entered",
  requestTrustLabel: "customer_claim_recorded",
  privacySafeExplanation: "Recommend Mai: available and safe before the next appointment.",
  skippedReasonCodes: ["SKILL_MISMATCH"],
  fairnessBandCents: 2_000,
  decisionFingerprint: "a".repeat(64),
  commandFingerprint: "b".repeat(64),
  actorRole: "receptionist",
  assignmentOutcome: "confirmed_recommendation",
  overrideReason: null,
  createdAt: "2026-09-02T18:01:00.000Z",
};

const staff = [
  { id: "staff-1", name: "Mai" },
  { id: "staff-2", name: "Linh" },
];
const services = [{ id: "service-1", name: "Deluxe Pedicure" }];

describe("TurnIQ M3B role-safe projections", () => {
  it("makes the next recommendation dominant and stays quiet when no owner action is needed", () => {
    const view = projectTurnIqLiveBoard({
      businessDate: "2026-09-02",
      activePolicyVersionId: "policy-1",
      shifts: [shift],
      assignments: [assignment],
      staff,
      services,
      openExceptionCount: 0,
    });
    expect(view.nextRecommendation).toMatchObject({
      recommendedStaffName: "Mai",
      serviceName: "Deluxe Pedicure",
      skipped: [{ staffName: "Linh", reasonCodes: ["SKILL_MISMATCH"] }],
    });
    expect(view.ownerActionRequired).toBe(false);
    expect(view.ownerFreedomMessage).toContain("No owner action needed");
  });

  it("projects consent status and append-only performer corrections without peer money", () => {
    const swap: TurnIqSwapReadRow = {
      id: "swap-1",
      policyVersionId: "policy-1",
      assignmentId: "assignment-1",
      fromStaffId: "staff-1",
      toStaffId: "staff-2",
      reason: "Both technicians agreed before service.",
      status: "pending_consents",
      consentedStaffIds: ["staff-1"],
      requestedAt: "2026-09-02T18:02:00.000Z",
      appliedAt: null,
    };
    const correction: TurnIqCorrectionReadRow = {
      id: "correction-1",
      policyVersionId: "policy-1",
      assignmentId: "assignment-1",
      fairnessReceiptId: "receipt-1",
      sequence: 1,
      category: "wrong_technician",
      reason: "Linh performed the service.",
      previousStaffId: "staff-1",
      actualStaffId: "staff-2",
      turnMoved: true,
      opportunityCreditMovedCents: 7_000,
      correctedAt: "2026-09-02T19:00:00.000Z",
    };
    const board = projectTurnIqLiveBoard({
      businessDate: "2026-09-02",
      activePolicyVersionId: "policy-1",
      shifts: [shift],
      assignments: [],
      staff,
      services,
      openExceptionCount: 0,
      swaps: [swap],
      corrections: [correction],
    });
    expect(board.swaps[0]).toMatchObject({
      fromStaffName: "Mai",
      toStaffName: "Linh",
      consentCount: 1,
    });
    expect(board.recentCorrections[0]).toMatchObject({
      previousStaffName: "Mai",
      actualStaffName: "Linh",
    });

    const technician = projectTurnIqStaffView({
      activePolicyVersionId: "policy-1",
      staff: staff[0],
      staffDirectory: staff,
      shift,
      assignments: [],
      receipts: [],
      services,
      swaps: [swap],
      corrections: [correction],
    });
    expect(technician.pendingSwaps[0]).toMatchObject({
      fromStaffName: "Mai",
      toStaffName: "Linh",
      ownDecision: "accepted",
    });
    expect(technician.recentCorrections[0]).toMatchObject({
      direction: "moved_from_me",
      turnMoved: true,
    });
    expect(JSON.stringify(technician)).not.toContain("7000");
  });

  it("keeps active queue order and exposes inactive staff as not checked in", () => {
    const view = projectTurnIqLiveBoard({
      businessDate: "2026-09-02",
      activePolicyVersionId: "policy-1",
      shifts: [shift],
      assignments: [],
      staff,
      services,
      openExceptionCount: 0,
    });
    expect(view.staff).toEqual([
      expect.objectContaining({
        staffId: "staff-1",
        state: "active",
        queuePosition: 1,
      }),
      expect.objectContaining({
        staffId: "staff-2",
        state: "not_checked_in",
        queuePosition: null,
      }),
    ]);
  });

  it("returns only the technician's own credit and strips internal fingerprints", () => {
    const view = projectTurnIqStaffView({
      activePolicyVersionId: "policy-1",
      staff: staff[0],
      shift,
      assignments: [assignment],
      receipts: [receipt],
      services,
    });
    expect(view.ownOpportunityCreditCents).toBe(10_000);
    expect(view.activePolicyVersionId).toBe("policy-1");
    expect(view.recentReceipts).toHaveLength(1);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(receipt.decisionFingerprint);
    expect(serialized).not.toContain(receipt.commandFingerprint);
    expect(serialized).not.toContain("fairnessBandCents");
    expect(serialized).not.toContain("actualTip");
    expect(serialized).not.toContain("internalDecisionTrace");
  });

  it("attaches only the technician's own privacy-safe dispute to their receipt", () => {
    const view = projectTurnIqStaffView({
      activePolicyVersionId: "policy-1",
      staff: staff[0],
      shift,
      assignments: [assignment],
      receipts: [receipt],
      disputes: [
        {
          id: "dispute-1",
          policyVersionId: "policy-1",
          assignmentId: "assignment-1",
          fairnessReceiptId: "receipt-1",
          targetType: "fairness_receipt",
          raisedByStaffId: "staff-1",
          category: "assignment",
          privacySafeReason: "Please review this assignment.",
          status: "open",
          resolutionReason: null,
          stateVersion: 1,
          createdAt: "2026-09-02T18:02:00.000Z",
        },
      ],
      services,
    });
    expect(view.recentReceipts[0].dispute).toEqual({
      id: "dispute-1",
      status: "open",
      category: "assignment",
      reason: "Please review this assignment.",
      resolutionReason: null,
    });
    expect(JSON.stringify(view)).not.toContain("staff-2");
  });

  it("explains only the technician's own skip and attaches its review state", () => {
    const view = projectTurnIqStaffView({
      activePolicyVersionId: "policy-1",
      staff: staff[1],
      shift: null,
      assignments: [assignment],
      receipts: [],
      disputes: [
        {
          id: "skip-dispute-1",
          policyVersionId: "policy-1",
          assignmentId: "assignment-1",
          fairnessReceiptId: null,
          targetType: "skip_decision",
          raisedByStaffId: "staff-2",
          category: "skip_reason",
          privacySafeReason: "Please review my service qualification.",
          status: "open",
          resolutionReason: null,
          stateVersion: 1,
          createdAt: "2026-09-02T18:02:00.000Z",
        },
      ],
      services,
    });
    expect(view.whyNotMe).toEqual([
      expect.objectContaining({
        assignmentId: "assignment-1",
        serviceName: "Deluxe Pedicure",
        reasonCodes: ["SKILL_MISMATCH"],
        explanation:
          "Not eligible for this customer: the requested service is not enabled for you.",
        dispute: expect.objectContaining({
          id: "skip-dispute-1",
          status: "open",
        }),
      }),
    ]);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("fairnessCreditCents");
    expect(serialized).not.toContain("staff-1");
  });

  it("shows the affected technician their own refusal reason without peer truth", () => {
    const refused: TurnIqAssignmentReadRow = {
      ...assignment,
      id: "assignment-refused",
      status: "rejected",
      refusalCategory: "illness_emergency",
      refusalReason: "Approved illness; pause assignments safely.",
      refusalOutcome: "no_penalty_temporary_hold",
      refusedAt: "2026-09-02T18:03:00.000Z",
    };
    const view = projectTurnIqStaffView({
      activePolicyVersionId: "policy-1",
      staff: staff[0],
      shift,
      assignments: [refused],
      receipts: [],
      services,
    });
    expect(view.recentRefusals).toEqual([
      {
        assignmentId: "assignment-refused",
        serviceName: "Deluxe Pedicure",
        category: "illness_emergency",
        outcome: "no_penalty_temporary_hold",
        reason: "Approved illness; pause assignments safely.",
        refusedAt: "2026-09-02T18:03:00.000Z",
      },
    ]);
    expect(JSON.stringify(view)).not.toContain("staff-2");
  });

  it("projects redo origin and policy outcomes without exposing peer money", () => {
    const redo: TurnIqAssignmentReadRow = {
      ...assignment,
      id: "assignment-redo",
      redoOriginalAssignmentId: "assignment-original",
      redoCategory: "quality_issue",
      redoNote: "Repair one chipped nail under the salon guarantee.",
      redoConsumesTurn: false,
      redoCreditsOpportunity: false,
      redoClassifiedAt: "2026-09-02T18:04:00.000Z",
    };
    const completed: TurnIqAssignmentReadRow = {
      ...assignment,
      id: "assignment-original",
      status: "completed",
      assignedStaffId: "staff-1",
      completedAt: "2026-09-01T18:00:00.000Z",
    };
    const board = projectTurnIqLiveBoard({
      businessDate: "2026-09-02",
      activePolicyVersionId: "policy-1",
      shifts: [shift],
      assignments: [redo],
      redoCandidates: [completed],
      staff,
      services,
      openExceptionCount: 0,
    });
    expect(board.nextRecommendation?.redo).toEqual({
      originalAssignmentId: "assignment-original",
      category: "quality_issue",
      note: "Repair one chipped nail under the salon guarantee.",
      consumesTurn: false,
      creditsOpportunity: false,
    });
    expect(board.redoCandidates).toEqual([
      {
        assignmentId: "assignment-original",
        policyVersionId: "policy-1",
        serviceName: "Deluxe Pedicure",
        assignedStaffId: "staff-1",
        assignedStaffName: "Mai",
        completedAt: "2026-09-01T18:00:00.000Z",
      },
    ]);

    const tech = projectTurnIqStaffView({
      activePolicyVersionId: "policy-1",
      staff: staff[0],
      shift,
      assignments: [redo],
      receipts: [],
      services,
    });
    expect(tech.recentRedos).toEqual([
      expect.objectContaining({
        assignmentId: "assignment-redo",
        consumesTurn: false,
        creditsOpportunity: false,
      }),
    ]);
    expect(JSON.stringify(tech)).not.toMatch(/peer|tip|actualServiceRevenue/i);
  });

  it("reveals receipt fingerprints and fairness band only in the owner projection", () => {
    const staffReceipt = projectTurnIqFairnessReceipt({
      receipt,
      staff,
      services,
      includeOwnerDetail: false,
    });
    const ownerReceipt = projectTurnIqFairnessReceipt({
      receipt,
      staff,
      services,
      includeOwnerDetail: true,
      ownerFinancialTruth: {
        opportunityCreditCents: 5_000,
        actualServiceRevenueCents: 5_500,
        actualTaxCents: 300,
        actualTipCents: 1_000,
      },
    });
    expect(staffReceipt.ownerDetail).toBeNull();
    expect(ownerReceipt.ownerDetail).toEqual({
      fairnessBandCents: 2_000,
      opportunityCreditCents: 5_000,
      actualServiceRevenueCents: 5_500,
      actualTaxCents: 300,
      actualTipCents: 1_000,
      decisionFingerprint: "a".repeat(64),
      commandFingerprint: "b".repeat(64),
      actorRole: "receptionist",
    });
  });

  it("creates an exception inbox only for actionable exceptions", () => {
    const view = projectTurnIqExceptionInbox([
      {
        id: "exception-open",
        policyVersionId: "policy-1",
        assignmentId: "assignment-1",
        disputeId: null,
        exceptionType: "appointment_risk",
        status: "open",
        privacySafeSummary: "Appointment safety needs review.",
        recommendedAction: "Choose another technician.",
        stateVersion: 1,
        createdAt: "2026-09-02T18:00:00.000Z",
      },
      {
        id: "exception-done",
        policyVersionId: "policy-1",
        assignmentId: "assignment-2",
        disputeId: null,
        exceptionType: "resource_risk",
        status: "resolved",
        privacySafeSummary: "Resolved.",
        recommendedAction: "None.",
        stateVersion: 2,
        createdAt: "2026-09-02T17:00:00.000Z",
      },
    ]);
    expect(view.ownerActionRequired).toBe(true);
    expect(view.exceptions.map((entry) => entry.id)).toEqual(["exception-open"]);
    expect(view.exceptions[0].dispute).toBeNull();
  });
});
