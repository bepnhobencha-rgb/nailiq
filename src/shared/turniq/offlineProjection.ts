import type { TurnIqOfflineQueueRecord } from "@/shared/turniq/offlineContracts";
import type { TurnIqLiveBoardView, TurnIqStaffView } from "@/shared/turniq/readModels";

function nextQueuePosition(board: TurnIqLiveBoardView): number {
  return Math.max(0, ...board.staff.map((staff) => staff.queuePosition ?? 0)) + 1;
}

/**
 * Projects persisted offline commands onto the last authoritative snapshot.
 * This changes only what the primary device displays; the encrypted baseline
 * and its server-verified fingerprint remain immutable until reconnect.
 */
export function projectTurnIqOfflineBoard(
  baseline: TurnIqLiveBoardView,
  records: readonly TurnIqOfflineQueueRecord[],
): TurnIqLiveBoardView {
  let board: TurnIqLiveBoardView = structuredClone(baseline);
  const ordered = records
    .filter((record) => record.status === "queued" || record.status === "syncing")
    .sort(
    (left, right) => left.command.localSequence - right.command.localSequence,
  );

  for (const record of ordered) {
    const body = record.command.body;
    if (body.type === "shift") {
      const joiningPosition = nextQueuePosition(board);
      board = {
        ...board,
        staff: board.staff.map((staff) => {
          if (staff.staffId !== body.staffId) return staff;
          if (body.action === "check_in") {
            return { ...staff, state: "active", queuePosition: joiningPosition };
          }
          if (body.action === "check_out") {
            return { ...staff, state: "checked_out", queuePosition: null, isRecommendedNext: false };
          }
          if (body.action === "break") {
            return { ...staff, state: "approved_break", isRecommendedNext: false };
          }
          return { ...staff, state: "active" };
        }),
      };
      continue;
    }

    if (body.type === "assignment") {
      const currentAssignment = board.assignments.find(
        (assignment) => assignment.assignmentId === body.assignmentId,
      );
      const assignedStaffId = body.assignedStaffId ?? currentAssignment?.assignedStaffId;
      const assignedStaff = assignedStaffId
        ? board.staff.find((staff) => staff.staffId === assignedStaffId)
        : null;
      const status = body.action === "confirm" || body.action === "override"
        ? "confirmed" as const
        : body.action === "start"
          ? "in_progress" as const
          : "completed" as const;
      board = {
        ...board,
        nextRecommendation:
          board.nextRecommendation?.assignmentId === body.assignmentId
            ? null
            : board.nextRecommendation,
        assignments: board.assignments.map((assignment) => {
          if (assignment.assignmentId !== body.assignmentId) return assignment;
          return {
            ...assignment,
            status,
            ...(assignedStaff
              ? {
                  assignedStaffId: assignedStaff.staffId,
                  assignedStaffName: assignedStaff.staffName,
                }
              : {}),
          };
        }),
        staff: status === "completed" && assignedStaff
          ? board.staff.map((staff) => staff.staffId === assignedStaff.staffId
              ? { ...staff, turnsConsumed: staff.turnsConsumed + 1 }
              : staff)
          : board.staff,
      };
    }
  }
  return board;
}

/** Keeps the technician's own controls aligned with the projected board. */
export function projectTurnIqOfflineStaffView(
  baseline: TurnIqStaffView,
  board: TurnIqLiveBoardView,
): TurnIqStaffView {
  const staff = board.staff.find((entry) => entry.staffId === baseline.staffId);
  const assignment = baseline.currentAssignment
    ? board.assignments.find(
        (entry) => entry.assignmentId === baseline.currentAssignment?.assignmentId,
      )
    : null;
  return {
    ...baseline,
    ...(staff
      ? {
          shiftState: staff.state,
          queuePosition: staff.queuePosition,
          turnsConsumed: staff.turnsConsumed,
        }
      : {}),
    currentAssignment:
      !baseline.currentAssignment || !assignment || assignment.status === "completed"
        ? null
        : { ...baseline.currentAssignment, status: assignment.status },
  };
}
