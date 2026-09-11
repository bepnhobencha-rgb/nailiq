import "server-only";

type Stage = "client_configuration" | "salon_read" | "salon_gate" | "otp_read" |
  "rate_metering" | "voucher_read" | "pricing_read" | "pricing_validation";
type Outcome = "dependency_error" | "dependency_exception" | "missing_receipt" |
  "invalid_receipt" | "not_available" | "business_rejection";

const SAFE_CODES = new Set([
  "08000", "08001", "08006", "40001", "40P01", "57014", "53300", "57P01",
  "42501", "42883", "42P01", "PGRST000", "PGRST001", "PGRST002", "PGRST003", "PGRST202",
  "invalid_input", "invalid_group_size", "invalid_booking_data", "invalid_email",
  "invalid_salon", "invalid_service", "invalid_staff", "invalid_staff_capability",
  "invalid_resource", "invalid_combo", "invalid_addons", "invalid_addon", "invalid_reference", "invalid_time", "outside_hours",
  "slot_conflict", "voucher_invalid", "pricing_config_invalid", "unauthorized",
]);

/** Never pass a request, tenant identifier, message, stack or dependency payload to the sink. */
export function logGroupBookingFailure(stage: Stage, outcome: Outcome, code?: unknown) {
  try {
    console.warn(JSON.stringify({
      event: "group_booking_dependency_failure",
      stage,
      outcome,
      code: typeof code === "string" && SAFE_CODES.has(code) ? code : "unclassified",
    }));
  } catch {
    // Logging cannot change the customer outcome.
  }
}
