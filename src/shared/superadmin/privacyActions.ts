"use server";

import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getSuperAdminRole } from "@/shared/lib/superadmin";

const PRIVACY_OPERATOR_ROLES = new Set(["founder", "ops_admin"]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TerminalBookingPrivacyReason =
  | "verified_erasure_request"
  | "verified_retention_expiry"
  | "verified_legal_correction";

const PRIVACY_REASONS = new Set<TerminalBookingPrivacyReason>([
  "verified_erasure_request",
  "verified_retention_expiry",
  "verified_legal_correction",
]);

type PrivacyRedactionInput = {
  bookingId: string;
  salonId: string;
  /** Caller-generated UUID retained only for retry/idempotency audit. */
  requestId: string;
  /** Fixed code only. Names, phone numbers and free-form case notes are banned. */
  reasonCode: TerminalBookingPrivacyReason;
};

export type PrivacyRedactionResult =
  | {
      ok: true;
      replayed: boolean;
      scope: "single_terminal_booking";
      relatedRecordsRequireSeparateWorkflow: boolean;
    }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "invalid_request"
        | "invalid_terminal_booking"
        | "idempotency_mismatch"
        | "server_error";
    };

/**
 * Narrow superadmin privacy capability for one cancelled/no-show booking.
 *
 * The action never accepts an actor id, role, customer data or free-form reason.
 * It derives the caller from the authenticated session, admits founder/ops_admin
 * only, and delegates the mutation + audit to one service-only database RPC so
 * both commit or roll back together.  Linked account/payment/storage records are
 * explicitly outside this action and must use their own verified workflow.
 */
export async function redactTerminalBookingForPrivacy(
  input: PrivacyRedactionInput,
): Promise<PrivacyRedactionResult> {
  const bookingId = String(input.bookingId ?? "").trim();
  const salonId = String(input.salonId ?? "").trim();
  const requestId = String(input.requestId ?? "").trim();
  const reasonCode = input.reasonCode;
  if (
    !UUID_RE.test(bookingId) ||
    !UUID_RE.test(salonId) ||
    !UUID_RE.test(requestId) ||
    !PRIVACY_REASONS.has(reasonCode)
  ) {
    return { ok: false, error: "invalid_request" };
  }

  const session = await createClient();
  const {
    data: { user },
  } = await session.auth.getUser();
  if (!user) return { ok: false, error: "unauthorized" };
  const role = await getSuperAdminRole(user.id);
  if (!role || !PRIVACY_OPERATOR_ROLES.has(role)) {
    return { ok: false, error: "unauthorized" };
  }

  const admin = createServiceRoleClient();
  const { data, error } = await admin.rpc(
    "redact_terminal_booking_for_privacy" as never,
    {
      p_booking_id: bookingId,
      p_salon_id: salonId,
      p_actor_user_id: user.id,
      p_request_id: requestId,
      p_reason_code: reasonCode,
    } as never,
  );
  if (error) {
    console.error("[privacy/redact-terminal-booking]", error);
    return { ok: false, error: "server_error" };
  }

  const result = (Array.isArray(data) ? data[0] : data) as {
    success?: boolean;
    code?: string;
    replayed?: boolean;
    scope?: string;
    related_records_require_separate_workflow?: boolean;
  } | null;
  if (!result?.success) {
    if (
      result?.code === "invalid_terminal_booking" ||
      result?.code === "idempotency_mismatch" ||
      result?.code === "invalid_request"
    ) {
      return { ok: false, error: result.code };
    }
    return { ok: false, error: "server_error" };
  }
  if (result.scope !== "single_terminal_booking") {
    return { ok: false, error: "server_error" };
  }
  return {
    ok: true,
    replayed: result.replayed === true,
    scope: "single_terminal_booking",
    relatedRecordsRequireSeparateWorkflow:
      result.related_records_require_separate_workflow === true,
  };
}
