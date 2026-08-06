/** Normalize successful charge states across Square and Stripe. */
export function isSuccessfulNoShowChargeStatus(status: unknown): boolean {
  const normalized = String(status ?? "").trim().toLowerCase();
  return normalized === "completed" ||
    normalized === "approved" ||
    normalized === "succeeded";
}
