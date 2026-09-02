import { describe, expect, it } from "vitest";

import {
  TurnIqOnlineCommandError,
  transitionTurnIqAssignment,
  transitionTurnIqShift,
} from "@/shared/turniq/onlineCommandEngine";

import type {
  TurnIqAssignmentTransitionState,
  TurnIqCommandActor,
  TurnIqShiftTransitionState,
} from "@/shared/turniq/onlineCommandEngine";

const deskActor: TurnIqCommandActor = {
  userId: "user-receptionist",
  role: "receptionist",
  actsForOwnStaff: false,
};

const ownTechActor: TurnIqCommandActor = {
  userId: "user-tech",
  role: "nail_tech",
  actsForOwnStaff: true,
};

const otherTechActor: TurnIqCommandActor = {
  userId: "user-other-tech",
  role: "nail_tech",
  actsForOwnStaff: false,
};

function activeShift(): TurnIqShiftTransitionState {
  return {
    state: "active",
    checkedInAt: "2026-09-02T16:00:00.000Z",
    checkedOutAt: null,
    stateChangedAt: "2026-09-02T16:00:00.000Z",
    holdReason: null,
  };
}

function recommendedAssignment(): TurnIqAssignmentTransitionState {
  return {
    status: "recommended",
    recommendedStaffId: "staff-a",
    assignedStaffId: null,
    confirmationKind: null,
    confirmationActorUserId: null,
    overrideReason: null,
    opportunityCreditCents: 0,
    actualServiceRevenueCents: null,
    actualTaxCents: null,
    actualTipCents: null,
    turnConsumed: false,
    confirmedAt: null,
    startedAt: null,
    completedAt: null,
  };
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error("expected_transition_error");
  } catch (error) {
    expect(error).toBeInstanceOf(TurnIqOnlineCommandError);
    expect((error as TurnIqOnlineCommandError).code).toBe(code);
  }
}

describe("TurnIQ M3A online command engine", () => {
  it("checks a technician in without an existing open session", () => {
    const result = transitionTurnIqShift({
      current: null,
      command: { type: "check_in" },
      actor: ownTechActor,
      occurredAt: "2026-09-02T16:00:00.000Z",
    });
    expect(result.eventType).toBe("shift_checked_in");
    expect(result.next).toEqual(activeShift());
  });

  it("preserves the shift while break and return change only state truth", () => {
    const onBreak = transitionTurnIqShift({
      current: activeShift(),
      command: { type: "break", reason: "Lunch" },
      actor: ownTechActor,
      occurredAt: "2026-09-02T18:00:00.000Z",
    });
    expect(onBreak.next.state).toBe("approved_break");
    expect(onBreak.next.holdReason).toBe("Lunch");

    const returned = transitionTurnIqShift({
      current: onBreak.next,
      command: { type: "return" },
      actor: ownTechActor,
      occurredAt: "2026-09-02T18:30:00.000Z",
    });
    expect(returned.next.state).toBe("active");
    expect(returned.next.holdReason).toBeNull();
    expect(returned.next.checkedInAt).toBe(activeShift().checkedInAt);
  });

  it("reserves safety holds for desk roles", () => {
    expectCode(
      () =>
        transitionTurnIqShift({
          current: activeShift(),
          command: { type: "hold", reason: "Illness" },
          actor: ownTechActor,
          occurredAt: "2026-09-02T18:00:00.000Z",
        }),
      "forbidden",
    );
    const held = transitionTurnIqShift({
      current: activeShift(),
      command: { type: "hold", reason: "Illness" },
      actor: deskActor,
      occurredAt: "2026-09-02T18:00:00.000Z",
    });
    expect(held.next.state).toBe("temporary_hold");
  });

  it("rejects cross-staff tech actions and invalid/stale transitions", () => {
    expectCode(
      () =>
        transitionTurnIqShift({
          current: null,
          command: { type: "check_in" },
          actor: otherTechActor,
          occurredAt: "2026-09-02T16:00:00.000Z",
        }),
      "forbidden",
    );
    expectCode(
      () =>
        transitionTurnIqShift({
          current: activeShift(),
          command: { type: "return" },
          actor: deskActor,
          occurredAt: "2026-09-02T18:00:00.000Z",
        }),
      "invalid_transition",
    );
    expectCode(
      () =>
        transitionTurnIqShift({
          current: activeShift(),
          command: { type: "break", reason: "Lunch" },
          actor: deskActor,
          occurredAt: "2026-09-02T15:59:59.000Z",
        }),
      "stale_command_timestamp",
    );
  });

  it("confirms only the recommendation and requires desk authority", () => {
    const confirmed = transitionTurnIqAssignment({
      current: recommendedAssignment(),
      command: { type: "confirm", assignedStaffId: "staff-a" },
      actor: deskActor,
      occurredAt: "2026-09-02T17:00:00.000Z",
    });
    expect(confirmed.next.status).toBe("confirmed");
    expect(confirmed.next.confirmationKind).toBe("confirmed_recommendation");
    expect(confirmed.eventType).toBe("assignment_confirmed");

    expectCode(
      () =>
        transitionTurnIqAssignment({
          current: recommendedAssignment(),
          command: { type: "confirm", assignedStaffId: "staff-b" },
          actor: deskActor,
          occurredAt: "2026-09-02T17:00:00.000Z",
        }),
      "recommendation_mismatch",
    );
    expectCode(
      () =>
        transitionTurnIqAssignment({
          current: recommendedAssignment(),
          command: { type: "confirm", assignedStaffId: "staff-a" },
          actor: ownTechActor,
          occurredAt: "2026-09-02T17:00:00.000Z",
        }),
      "forbidden",
    );
  });

  it("records an override reason without consuming a turn", () => {
    const result = transitionTurnIqAssignment({
      current: recommendedAssignment(),
      command: {
        type: "override",
        assignedStaffId: "staff-b",
        reason: "Customer changed request at check-in",
      },
      actor: deskActor,
      occurredAt: "2026-09-02T17:00:00.000Z",
    });
    expect(result.next.assignedStaffId).toBe("staff-b");
    expect(result.next.overrideReason).toBe(
      "Customer changed request at check-in",
    );
    expect(result.turnConsumedDelta).toBe(0);
  });

  it("allows a technician to start and complete only their own assignment", () => {
    const confirmed = transitionTurnIqAssignment({
      current: recommendedAssignment(),
      command: { type: "confirm", assignedStaffId: "staff-a" },
      actor: deskActor,
      occurredAt: "2026-09-02T17:00:00.000Z",
    }).next;
    const started = transitionTurnIqAssignment({
      current: confirmed,
      command: { type: "start" },
      actor: ownTechActor,
      occurredAt: "2026-09-02T17:05:00.000Z",
    });
    expect(started.next.status).toBe("in_progress");

    const completed = transitionTurnIqAssignment({
      current: started.next,
      command: {
        type: "complete",
        opportunityCreditCents: 6_500,
        actualServiceRevenueCents: 6_000,
        actualTaxCents: 300,
        actualTipCents: 1_200,
      },
      actor: ownTechActor,
      occurredAt: "2026-09-02T18:05:00.000Z",
    });
    expect(completed.next.status).toBe("completed");
    expect(completed.next.turnConsumed).toBe(true);
    expect(completed.turnConsumedDelta).toBe(1);
    expect(completed.opportunityCreditDeltaCents).toBe(6_500);

    expectCode(
      () =>
        transitionTurnIqAssignment({
          current: confirmed,
          command: { type: "start" },
          actor: otherTechActor,
          occurredAt: "2026-09-02T17:05:00.000Z",
        }),
      "own_assignment_required",
    );
  });

  it("never consumes a turn before completion and rejects invalid money", () => {
    const confirmed = transitionTurnIqAssignment({
      current: recommendedAssignment(),
      command: { type: "confirm", assignedStaffId: "staff-a" },
      actor: deskActor,
      occurredAt: "2026-09-02T17:00:00.000Z",
    });
    expect(confirmed.next.turnConsumed).toBe(false);

    const started = transitionTurnIqAssignment({
      current: confirmed.next,
      command: { type: "start" },
      actor: deskActor,
      occurredAt: "2026-09-02T17:05:00.000Z",
    });
    expect(started.next.turnConsumed).toBe(false);
    expectCode(
      () =>
        transitionTurnIqAssignment({
          current: started.next,
          command: {
            type: "complete",
            opportunityCreditCents: -1,
            actualServiceRevenueCents: null,
            actualTaxCents: null,
            actualTipCents: null,
          },
          actor: deskActor,
          occurredAt: "2026-09-02T18:05:00.000Z",
        }),
      "invalid_money",
    );
  });

  it("does not mutate command inputs", () => {
    const current = recommendedAssignment();
    const before = structuredClone(current);
    transitionTurnIqAssignment({
      current,
      command: { type: "confirm", assignedStaffId: "staff-a" },
      actor: deskActor,
      occurredAt: "2026-09-02T17:00:00.000Z",
    });
    expect(current).toEqual(before);
  });
});
