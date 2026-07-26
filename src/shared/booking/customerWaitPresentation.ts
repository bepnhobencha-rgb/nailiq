export type CustomerBookingKind = "walkin" | "appointment";

export type CustomerBookingStatus =
  | "waiting"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

export type CustomerWaitSurface =
  | "appointment"
  | "waiting"
  | "ready"
  | "done"
  | "cancelled";

export function customerBookingKindFromSource(
  source: string | null | undefined,
): CustomerBookingKind {
  return String(source ?? "").trim().toLowerCase() === "walkin"
    ? "walkin"
    : "appointment";
}

export function resolveCustomerWaitSurface(
  kind: CustomerBookingKind,
  status: CustomerBookingStatus,
): CustomerWaitSurface {
  if (status === "cancelled" || status === "no_show") return "cancelled";
  if (status === "completed") return "done";
  if (status === "in_progress") return "ready";
  if (kind === "appointment" && status === "confirmed") {
    return "appointment";
  }
  return "waiting";
}
