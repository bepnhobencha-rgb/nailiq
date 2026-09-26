/** Attendance is independent of claiming a contact card on the shared roster. */
export type GroupMemberStatus = "pending" | "confirmed" | "replacement_pending" | "replacement_confirmed" | "cancelled" | "declined" | "completed" | "no_show";

export function groupMemberStatus(input: {
  status?: string | null;
  attendanceStatus?: string | null;
  replacement?: "pending" | "accepted";
}): GroupMemberStatus {
  if (input.status === "cancelled") return "cancelled";
  if (input.status === "no_show") return "no_show";
  if (input.status === "completed") return "completed";
  if (input.attendanceStatus === "declined") return "declined";
  if (input.replacement === "pending") return "replacement_pending";
  if (input.attendanceStatus === "confirmed" && ["confirmed", "arrived", "waiting", "in_progress", "late"].includes(input.status ?? "")) {
    return input.replacement === "accepted" ? "replacement_confirmed" : "confirmed";
  }
  return "pending";
}

export function groupMemberCountsAsConfirmed(status?: GroupMemberStatus): boolean {
  return status === "confirmed" || status === "replacement_confirmed";
}

export function groupMemberHasActiveSlot(status?: GroupMemberStatus): boolean {
  return status === "pending" || status === "confirmed" || status === "replacement_pending" || status === "replacement_confirmed";
}

export function groupMemberIsReadOnly(status?: GroupMemberStatus, replacement?: "pending" | "accepted"): boolean {
  return replacement !== undefined || !groupMemberHasActiveSlot(status);
}
