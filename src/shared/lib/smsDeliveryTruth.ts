import { createHash } from "node:crypto";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type SmsAttemptClaim = {
  attemptId: string;
  attemptToken: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function smsFingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function claimSmsDeliveryAttempt(input: {
  salonId: string;
  bookingId?: string | null;
  notificationType?: string;
  recipientE164: string;
  body: string;
}): Promise<SmsAttemptClaim | null> {
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "claim_sms_delivery_attempt" as never,
      {
        p_salon_id: input.salonId,
        p_booking_id: input.bookingId ?? null,
        p_notification_type: input.notificationType ?? "sms_dispatch",
        p_recipient_fingerprint: smsFingerprint(input.recipientE164),
        p_body_fingerprint: smsFingerprint(input.body),
      } as never,
    );
    if (error || !record(data) || data.success !== true || data.code !== "claimed") {
      return null;
    }
    const attemptId = String(data.attempt_id ?? "");
    const attemptToken = String(data.attempt_token ?? "");
    return UUID_RE.test(attemptId) && UUID_RE.test(attemptToken)
      ? { attemptId, attemptToken }
      : null;
  } catch {
    return null;
  }
}

export async function completeSmsDeliveryAttempt(input: {
  attemptId: string;
  attemptToken: string;
  status: "accepted" | "failed" | "suppressed" | "unknown";
  providerMessageSid?: string | null;
  errorCode?: string | null;
  suppressionReason?: string | null;
}): Promise<boolean> {
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "complete_sms_delivery_attempt" as never,
      {
        p_attempt_id: input.attemptId,
        p_attempt_token: input.attemptToken,
        p_status: input.status,
        p_provider_message_sid: input.providerMessageSid ?? null,
        p_error_code: input.errorCode ?? null,
        p_suppression_reason: input.suppressionReason ?? null,
      } as never,
    );
    return !error && record(data) && data.success === true &&
      ["completed", "already_completed", "callback_terminal"].includes(String(data.code ?? ""));
  } catch {
    return false;
  }
}

export async function recordSmsDeliveryAttemptReceipt(input: {
  attemptId: string;
  messageSid: string;
  status: "delivered" | "undelivered" | "failed";
  errorCode?: string | null;
}): Promise<
  | { ok: true; code: "applied" | "exact_replay" }
  | { ok: false; code: "invalid_receipt" | "terminal_conflict" | "database_error" }
> {
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "record_sms_delivery_attempt_receipt" as never,
      {
        p_attempt_id: input.attemptId,
        p_message_sid: input.messageSid,
        p_status: input.status,
        p_error_code: input.errorCode ?? null,
      } as never,
    );
    if (error || !record(data)) return { ok: false, code: "database_error" };
    if (data.success === true && (data.code === "applied" || data.code === "exact_replay")) {
      return { ok: true, code: data.code };
    }
    if (data.code === "invalid_receipt") return { ok: false, code: "invalid_receipt" };
    if (data.code === "terminal_conflict" || data.code === "correlation_conflict" || data.code === "state_conflict") {
      return { ok: false, code: "terminal_conflict" };
    }
    return { ok: false, code: "database_error" };
  } catch {
    return { ok: false, code: "database_error" };
  }
}

export function bindSmsAttemptToStatusCallback(
  explicitUrl: string | undefined,
  attemptId: string,
): string | null {
  const candidates = [
    explicitUrl?.trim(),
    process.env.NEXT_PUBLIC_APP_URL?.trim()
      ? `${process.env.NEXT_PUBLIC_APP_URL.trim().replace(/\/$/u, "")}/api/twilio/status`
      : "",
    process.env.VERCEL_URL?.trim()
      ? `https://${process.env.VERCEL_URL.trim().replace(/\/$/u, "")}/api/twilio/status`
      : "",
    process.env.NODE_ENV === "production" ? "https://nailiq.ca/api/twilio/status" : "",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== "https:" || url.username || url.password) continue;
      url.searchParams.set("sms_attempt_id", attemptId);
      if (explicitUrl?.trim() && candidate === explicitUrl.trim()) {
        // Existing durable domain outboxes (confirmation/reminder/review/staff)
        // still receive their established receipt update in addition to the
        // universal attempt ledger.
        url.searchParams.set("sms_domain_callback", "1");
      }
      return url.toString();
    } catch {
      // Try the next trusted runtime source.
    }
  }
  return null;
}
