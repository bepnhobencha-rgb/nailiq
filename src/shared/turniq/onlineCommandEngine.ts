import { assertTurnIqCents } from "@/shared/turniq/contracts";

import type { TurnIqIsoTimestamp, TurnIqMoneyCents } from "@/shared/turniq/contracts";

export const TURNIQ_ONLINE_ACTOR_ROLES = [
  "owner",
  "admin",
  "senior",
  "receptionist",
  "nail_tech",
] as const;

export type TurnIqOnlineActorRole = (typeof TURNIQ_ONLINE_ACTOR_ROLES)[number];

export const TURNIQ_SHIFT_STATES = [
  "active",
  "approved_break",
  "temporary_hold",
  "checked_out",
] as const;

export type TurnIqShiftState = (typeof TURNIQ_SHIFT_STATES)[number];

export type TurnIqShiftTransitionState = {
  state: TurnIqShiftState;
  checkedInAt: TurnIqIsoTimestamp;
  checkedOutAt: TurnIqIsoTimestamp | null;
  stateChangedAt: TurnIqIsoTimestamp;
  holdReason: string | null;
};

export type TurnIqShiftCommand =
  | { type: "check_in" }
  | { type: "break"; reason: string }
  | { type: "return" }
  | { type: "hold"; reason: string }
  | { type: "release_hold" }
  | { type: "check_out" };

export type TurnIqAssignmentTransitionState = {
  status:
    | "recommended"
    | "confirmed"
    | "in_progress"
    | "completed"
    | "cancelled"
    | "rejected";
  recommendedStaffId: string | null;
  assignedStaffId: string | null;
  confirmationKind: "confirmed_recommendation" | "override" | null;
  confirmationActorUserId: string | null;
  overrideReason: string | null;
  opportunityCreditCents: TurnIqMoneyCents;
  actualServiceRevenueCents: TurnIqMoneyCents | null;
  actualTaxCents: TurnIqMoneyCents | null;
  actualTipCents: TurnIqMoneyCents | null;
  turnConsumed: boolean;
  confirmedAt: TurnIqIsoTimestamp | null;
  startedAt: TurnIqIsoTimestamp | null;
  completedAt: TurnIqIsoTimestamp | null;
};

export type TurnIqAssignmentCommand =
  | { type: "confirm"; assignedStaffId: string }
  | { type: "override"; assignedStaffId: string; reason: string }
  | { type: "start" }
  | {
      type: "complete";
      opportunityCreditCents: TurnIqMoneyCents;
      actualServiceRevenueCents: TurnIqMoneyCents | null;
      actualTaxCents: TurnIqMoneyCents | null;
      actualTipCents: TurnIqMoneyCents | null;
    };

export type TurnIqCommandActor = {
  userId: string;
  role: TurnIqOnlineActorRole;
  actsForOwnStaff: boolean;
};

export type TurnIqShiftTransition = {
  next: TurnIqShiftTransitionState;
  eventType:
    | "shift_checked_in"
    | "shift_break_started"
    | "shift_returned"
    | "shift_hold_started"
    | "shift_hold_released"
    | "shift_checked_out";
};

export type TurnIqAssignmentTransition = {
  next: TurnIqAssignmentTransitionState;
  eventType:
    | "assignment_confirmed"
    | "assignment_overridden"
    | "service_started"
    | "service_completed";
  turnConsumedDelta: 0 | 1;
  opportunityCreditDeltaCents: TurnIqMoneyCents;
};

export type TurnIqOnlineCommandErrorCode =
  | "invalid_timestamp"
  | "stale_command_timestamp"
  | "invalid_transition"
  | "reason_required"
  | "assigned_staff_required"
  | "recommendation_mismatch"
  | "forbidden"
  | "own_assignment_required"
  | "invalid_money";

export class TurnIqOnlineCommandError extends Error {
  constructor(readonly code: TurnIqOnlineCommandErrorCode) {
    super(code);
    this.name = "TurnIqOnlineCommandError";
  }
}

const DESK_ROLES = new Set<TurnIqOnlineActorRole>([
  "owner",
  "admin",
  "senior",
  "receptionist",
]);

function normalizedReason(reason: string): string {
  const value = reason.trim();
  if (value.length < 1 || value.length > 500) {
    throw new TurnIqOnlineCommandError("reason_required");
  }
  return value;
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TurnIqOnlineCommandError("invalid_timestamp");
  }
  return parsed;
}

function assertNotBefore(value: string, boundary: string): void {
  if (timestampMs(value) < timestampMs(boundary)) {
    throw new TurnIqOnlineCommandError("stale_command_timestamp");
  }
}

function assertSelfOrDesk(actor: TurnIqCommandActor): void {
  if (!DESK_ROLES.has(actor.role) && !actor.actsForOwnStaff) {
    throw new TurnIqOnlineCommandError("forbidden");
  }
}

function assertDesk(actor: TurnIqCommandActor): void {
  if (!DESK_ROLES.has(actor.role)) {
    throw new TurnIqOnlineCommandError("forbidden");
  }
}

export function transitionTurnIqShift(input: {
  current: TurnIqShiftTransitionState | null;
  command: TurnIqShiftCommand;
  actor: TurnIqCommandActor;
  occurredAt: TurnIqIsoTimestamp;
}): TurnIqShiftTransition {
  timestampMs(input.occurredAt);
  assertSelfOrDesk(input.actor);

  if (input.command.type === "check_in") {
    if (input.current !== null) {
      throw new TurnIqOnlineCommandError("invalid_transition");
    }
    return {
      next: {
        state: "active",
        checkedInAt: input.occurredAt,
        checkedOutAt: null,
        stateChangedAt: input.occurredAt,
        holdReason: null,
      },
      eventType: "shift_checked_in",
    };
  }

  const current = input.current;
  if (current === null || current.state === "checked_out") {
    throw new TurnIqOnlineCommandError("invalid_transition");
  }
  assertNotBefore(input.occurredAt, current.stateChangedAt);

  if (input.command.type === "break") {
    if (current.state !== "active") {
      throw new TurnIqOnlineCommandError("invalid_transition");
    }
    return {
      next: {
        ...current,
        state: "approved_break",
        stateChangedAt: input.occurredAt,
        holdReason: normalizedReason(input.command.reason),
      },
      eventType: "shift_break_started",
    };
  }

  if (input.command.type === "return") {
    if (current.state !== "approved_break") {
      throw new TurnIqOnlineCommandError("invalid_transition");
    }
    return {
      next: {
        ...current,
        state: "active",
        stateChangedAt: input.occurredAt,
        holdReason: null,
      },
      eventType: "shift_returned",
    };
  }

  if (input.command.type === "hold") {
    assertDesk(input.actor);
    if (current.state !== "active") {
      throw new TurnIqOnlineCommandError("invalid_transition");
    }
    return {
      next: {
        ...current,
        state: "temporary_hold",
        stateChangedAt: input.occurredAt,
        holdReason: normalizedReason(input.command.reason),
      },
      eventType: "shift_hold_started",
    };
  }

  if (input.command.type === "release_hold") {
    assertDesk(input.actor);
    if (current.state !== "temporary_hold") {
      throw new TurnIqOnlineCommandError("invalid_transition");
    }
    return {
      next: {
        ...current,
        state: "active",
        stateChangedAt: input.occurredAt,
        holdReason: null,
      },
      eventType: "shift_hold_released",
    };
  }

  return {
    next: {
      ...current,
      state: "checked_out",
      checkedOutAt: input.occurredAt,
      stateChangedAt: input.occurredAt,
      holdReason: null,
    },
    eventType: "shift_checked_out",
  };
}

function assertCompletionMoney(
  command: Extract<TurnIqAssignmentCommand, { type: "complete" }>,
): void {
  try {
    assertTurnIqCents(command.opportunityCreditCents, "opportunityCreditCents");
    for (const [field, value] of [
      ["actualServiceRevenueCents", command.actualServiceRevenueCents],
      ["actualTaxCents", command.actualTaxCents],
      ["actualTipCents", command.actualTipCents],
    ] as const) {
      if (value !== null) assertTurnIqCents(value, field);
    }
  } catch {
    throw new TurnIqOnlineCommandError("invalid_money");
  }
}

export function transitionTurnIqAssignment(input: {
  current: TurnIqAssignmentTransitionState;
  command: TurnIqAssignmentCommand;
  actor: TurnIqCommandActor;
  occurredAt: TurnIqIsoTimestamp;
}): TurnIqAssignmentTransition {
  timestampMs(input.occurredAt);
  const { current, command, actor } = input;

  if (command.type === "confirm" || command.type === "override") {
    assertDesk(actor);
    if (current.status !== "recommended") {
      throw new TurnIqOnlineCommandError("invalid_transition");
    }
    if (!command.assignedStaffId.trim()) {
      throw new TurnIqOnlineCommandError("assigned_staff_required");
    }
    if (
      command.type === "confirm" &&
      command.assignedStaffId !== current.recommendedStaffId
    ) {
      throw new TurnIqOnlineCommandError("recommendation_mismatch");
    }
    const overrideReason =
      command.type === "override" ? normalizedReason(command.reason) : null;
    return {
      next: {
        ...current,
        status: "confirmed",
        assignedStaffId: command.assignedStaffId,
        confirmationKind:
          command.type === "override"
            ? "override"
            : "confirmed_recommendation",
        confirmationActorUserId: actor.userId,
        overrideReason,
        confirmedAt: input.occurredAt,
      },
      eventType:
        command.type === "override"
          ? "assignment_overridden"
          : "assignment_confirmed",
      turnConsumedDelta: 0,
      opportunityCreditDeltaCents: 0,
    };
  }

  if (command.type === "start") {
    if (!DESK_ROLES.has(actor.role) && !actor.actsForOwnStaff) {
      throw new TurnIqOnlineCommandError("own_assignment_required");
    }
    if (current.status !== "confirmed" || current.confirmedAt === null) {
      throw new TurnIqOnlineCommandError("invalid_transition");
    }
    assertNotBefore(input.occurredAt, current.confirmedAt);
    return {
      next: {
        ...current,
        status: "in_progress",
        startedAt: input.occurredAt,
      },
      eventType: "service_started",
      turnConsumedDelta: 0,
      opportunityCreditDeltaCents: 0,
    };
  }

  if (!DESK_ROLES.has(actor.role) && !actor.actsForOwnStaff) {
    throw new TurnIqOnlineCommandError("own_assignment_required");
  }
  if (current.status !== "in_progress" || current.startedAt === null) {
    throw new TurnIqOnlineCommandError("invalid_transition");
  }
  assertNotBefore(input.occurredAt, current.startedAt);
  assertCompletionMoney(command);
  return {
    next: {
      ...current,
      status: "completed",
      opportunityCreditCents: command.opportunityCreditCents,
      actualServiceRevenueCents: command.actualServiceRevenueCents,
      actualTaxCents: command.actualTaxCents,
      actualTipCents: command.actualTipCents,
      turnConsumed: true,
      completedAt: input.occurredAt,
    },
    eventType: "service_completed",
    turnConsumedDelta: 1,
    opportunityCreditDeltaCents: command.opportunityCreditCents,
  };
}
