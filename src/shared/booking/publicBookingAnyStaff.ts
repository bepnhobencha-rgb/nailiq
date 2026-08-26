export function resolveAnyStaffForPublicBooking(params: {
  mode: "quote" | "submit";
  idempotencyReplay: boolean;
  quotedStaffId?: string | null;
  freeStaffIds: readonly string[];
  pickFreeStaff: (freeStaffIds: readonly string[]) => string | null;
}): string | null {
  const quoted = params.quotedStaffId?.trim() || null;
  if (params.mode === "submit" && params.idempotencyReplay && quoted) {
    // A response-loss retry must reach the database with the exact original
    // request material. The committed booking itself makes this staff appear
    // occupied; re-selecting here would defeat the DB idempotency replay.
    return quoted;
  }
  if (params.freeStaffIds.length === 0) return null;
  if (params.mode === "submit" && quoted && params.freeStaffIds.includes(quoted)) {
    return quoted;
  }
  return params.pickFreeStaff(params.freeStaffIds);
}
