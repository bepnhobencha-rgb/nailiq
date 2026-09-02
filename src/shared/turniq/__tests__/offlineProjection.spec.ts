import { describe, expect, it } from "vitest";

import type { TurnIqOfflineQueueRecord } from "@/shared/turniq/offlineContracts";
import {
  projectTurnIqOfflineBoard,
  projectTurnIqOfflineStaffView,
} from "@/shared/turniq/offlineProjection";
import type { TurnIqLiveBoardView, TurnIqStaffView } from "@/shared/turniq/readModels";

const ids = {
  salon: "00000000-0000-4000-8000-000000000001",
  device: "00000000-0000-4000-8000-000000000002",
  policy: "00000000-0000-4000-8000-000000000003",
  actor: "00000000-0000-4000-8000-000000000004",
  assignment: "00000000-0000-4000-8000-000000000005",
  staff: "00000000-0000-4000-8000-000000000006",
};

const board: TurnIqLiveBoardView = {
  businessDate: "2026-09-02",
  activePolicyVersionId: ids.policy,
  ownerActionRequired: false,
  ownerFreedomMessage: "Continue normally",
  openExceptionCount: 0,
  nextRecommendation: {
    assignmentId: ids.assignment,
    policyVersionId: ids.policy,
    bookingId: null,
    recommendedStaffId: ids.staff,
    recommendedStaffName: "Mai",
    serviceName: "Pedicure",
    explanation: "Safe next turn",
    requestedTechTrustLabel: null,
    redo: null,
    skipped: [],
  },
  redoCandidates: [],
  swaps: [],
  recentCorrections: [],
  staff: [{
    staffId: ids.staff,
    staffName: "Mai",
    state: "active",
    queuePosition: 1,
    turnsConsumed: 0,
    isRecommendedNext: true,
  }],
  assignments: [{
    assignmentId: ids.assignment,
    policyVersionId: ids.policy,
    bookingId: null,
    status: "recommended",
    serviceName: "Pedicure",
    assignedStaffId: null,
    recommendedStaffName: "Mai",
    assignedStaffName: null,
    explanation: "Safe next turn",
  }],
};

function record(sequence: number, body: TurnIqOfflineQueueRecord["command"]["body"]): TurnIqOfflineQueueRecord {
  return {
    status: "queued",
    command: {
      schemaVersion: 1,
      commandId: `00000000-0000-4000-8000-${String(100 + sequence).padStart(12, "0")}`,
      salonId: ids.salon,
      deviceId: ids.device,
      deviceGeneration: 1,
      policyVersionId: ids.policy,
      localSequence: sequence,
      expectedStateVersion: sequence - 1,
      actorUserId: ids.actor,
      clientTimestamp: "2026-09-02T20:00:00.000Z",
      snapshotFingerprint: "a".repeat(64),
      requestFingerprint: "b".repeat(64),
      body,
    },
  };
}

describe("projectTurnIqOfflineBoard", () => {
  it("projects confirm, start and completion once without mutating the baseline", () => {
    const projected = projectTurnIqOfflineBoard(board, [
      record(1, { type: "assignment", assignmentId: ids.assignment, action: "confirm", assignedStaffId: ids.staff }),
      record(2, { type: "assignment", assignmentId: ids.assignment, action: "start" }),
      record(3, { type: "assignment", assignmentId: ids.assignment, action: "complete" }),
    ]);
    expect(projected.nextRecommendation).toBeNull();
    expect(projected.assignments[0]).toMatchObject({ status: "completed", assignedStaffName: "Mai" });
    expect(projected.staff[0].turnsConsumed).toBe(1);
    expect(board.assignments[0].status).toBe("recommended");
  });

  it("preserves queue position on break and removes it on checkout", () => {
    expect(projectTurnIqOfflineBoard(board, [
      record(1, { type: "shift", staffId: ids.staff, action: "break", reason: "Approved" }),
    ]).staff[0]).toMatchObject({ state: "approved_break", queuePosition: 1 });
    expect(projectTurnIqOfflineBoard(board, [
      record(1, { type: "shift", staffId: ids.staff, action: "check_out" }),
    ]).staff[0]).toMatchObject({ state: "checked_out", queuePosition: null });
  });

  it("never projects a conflicted action over authoritative server truth", () => {
    expect(projectTurnIqOfflineBoard(board, [{
      ...record(1, {
        type: "assignment",
        assignmentId: ids.assignment,
        action: "confirm",
        assignedStaffId: ids.staff,
      }),
      status: "conflict",
      conflictCode: "stale_snapshot",
    }]).assignments[0].status).toBe("recommended");
  });

  it("keeps the technician view aligned and removes a completed action", () => {
    const staffView: TurnIqStaffView = {
      staffId: ids.staff,
      staffName: "Mai",
      businessDate: "2026-09-02",
      activePolicyVersionId: ids.policy,
      shiftState: "active",
      queuePosition: 1,
      turnsConsumed: 0,
      ownOpportunityCreditCents: 0,
      currentAssignment: {
        assignmentId: ids.assignment,
        policyVersionId: ids.policy,
        status: "recommended",
        serviceName: "Pedicure",
        explanation: "Safe next turn",
      },
      whyNotMe: [],
      recentRefusals: [],
      recentRedos: [],
      pendingSwaps: [],
      recentCorrections: [],
      recentReceipts: [],
    };
    const projected = projectTurnIqOfflineBoard(board, [
      record(1, { type: "assignment", assignmentId: ids.assignment, action: "confirm", assignedStaffId: ids.staff }),
      record(2, { type: "assignment", assignmentId: ids.assignment, action: "start" }),
      record(3, { type: "assignment", assignmentId: ids.assignment, action: "complete" }),
    ]);
    expect(projectTurnIqOfflineStaffView(staffView, projected)).toMatchObject({
      turnsConsumed: 1,
      currentAssignment: null,
    });
  });
});
