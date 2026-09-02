import type { SalonMemberRole } from "@/shared/lib/salonMemberRole";

export type TurnIqSurface =
  | "live_board"
  | "staff_view"
  | "fairness_receipt"
  | "exception_inbox";

export function canUseTurnIqLiveBoard(role: SalonMemberRole): boolean {
  return role !== "nail_tech";
}

const STAFF_VIEW_ROLES: ReadonlySet<SalonMemberRole> = new Set([
  "owner",
  "admin",
  "senior",
  "receptionist",
  "nail_tech",
]);

export function canUseTurnIqStaffView(role: SalonMemberRole): boolean {
  return STAFF_VIEW_ROLES.has(role);
}

export function canSeeTurnIqOwnerFinancialTruth(
  role: SalonMemberRole,
): boolean {
  return role === "owner" || role === "admin";
}

export function canUseTurnIqExceptionInbox(role: SalonMemberRole): boolean {
  return role === "owner" || role === "admin";
}

export function canCreateTurnIqDispute(actorStaffId: string | null): boolean {
  return actorStaffId !== null;
}

export function canResolveTurnIqTrustItem(role: SalonMemberRole): boolean {
  return role === "owner" || role === "admin";
}

export function canIssueTurnIqShiftCommand(
  role: SalonMemberRole,
  actorStaffId: string | null,
  targetStaffId: string,
): boolean {
  return role !== "nail_tech" || actorStaffId === targetStaffId;
}

export function canIssueTurnIqAssignmentCommand(input: {
  role: SalonMemberRole;
  actorStaffId: string | null;
  assignedStaffId: string | null;
  commandType: "confirm" | "override" | "start" | "complete";
}): boolean {
  if (input.role !== "nail_tech") return true;
  return (
    (input.commandType === "start" || input.commandType === "complete") &&
    input.actorStaffId !== null &&
    input.actorStaffId === input.assignedStaffId
  );
}

/**
 * A technician may report a concern, but may not classify their own refusal as
 * approved or no-penalty. The supervised M3H refusal command is desk-only so
 * the policy outcome cannot be self-selected silently.
 */
export function canIssueTurnIqRefusalCommand(
  role: SalonMemberRole,
): boolean {
  return role !== "nail_tech";
}

/** Redo classification determines a policy outcome, so it is desk-only. */
export function canIssueTurnIqRedoCommand(role: SalonMemberRole): boolean {
  return role !== "nail_tech";
}

export function canIssueTurnIqSwapCommand(input: {
  role: SalonMemberRole;
  actorStaffId: string | null;
  commandType: "request_swap" | "consent_swap" | "confirm_swap";
}): boolean {
  if (input.commandType === "consent_swap") return input.actorStaffId !== null;
  if (input.commandType === "confirm_swap") return input.role !== "nail_tech";
  return input.role !== "nail_tech" || input.actorStaffId !== null;
}

export function canIssueTurnIqCorrectionCommand(role: SalonMemberRole): boolean {
  return role === "owner" || role === "admin";
}
