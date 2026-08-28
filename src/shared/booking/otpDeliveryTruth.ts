import "server-only";

import { createHash } from "node:crypto";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type BookingOtpChannel = "sms" | "email";
export type BookingOtpCompletionStatus =
  | "provider_accepted"
  | "failed"
  | "suppressed"
  | "unknown";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isBookingOtpDeliveryAttemptId(value: string): boolean {
  return UUID_RE.test(value);
}

export function bookingOtpRecipientFingerprint(recipient: string): string {
  return createHash("sha256")
    .update(recipient.trim().toLowerCase(), "utf8")
    .digest("hex");
}

export async function createBookingOtpDeliveryAttempt(input: {
  salonId: string;
  channel: BookingOtpChannel;
  recipient: string;
}): Promise<{ ok: true; attemptId: string; recipientFingerprint: string } | {
  ok: false;
  error: "delivery_truth_unavailable";
}> {
  const recipientFingerprint = bookingOtpRecipientFingerprint(input.recipient);
  try {
    const db = createServiceRoleClient();
    const { data, error } = await db.rpc(
      "create_booking_otp_delivery_attempt" as never,
      {
        p_salon_id: input.salonId,
        p_channel: input.channel,
        p_recipient_fingerprint: recipientFingerprint,
      } as never,
    );
    const attemptId = typeof data === "string" ? data : "";
    if (error || !UUID_RE.test(attemptId)) {
      console.error("[bookingOtpDeliveryTruth] claim unavailable", {
        channel: input.channel,
        code: typeof (error as { code?: unknown } | null)?.code === "string"
          ? (error as { code: string }).code
          : "database_error",
      });
      return { ok: false, error: "delivery_truth_unavailable" };
    }
    return { ok: true, attemptId, recipientFingerprint };
  } catch {
    console.error("[bookingOtpDeliveryTruth] claim threw", { channel: input.channel });
    return { ok: false, error: "delivery_truth_unavailable" };
  }
}

export async function completeBookingOtpDeliveryAttempt(input: {
  attemptId: string;
  status: BookingOtpCompletionStatus;
  providerRequestId?: string | null;
  providerAttemptId?: string | null;
  errorCode?: string | null;
}): Promise<boolean> {
  if (!UUID_RE.test(input.attemptId)) return false;
  try {
    const db = createServiceRoleClient();
    const { data, error } = await db.rpc(
      "complete_booking_otp_delivery_attempt" as never,
      {
        p_attempt_id: input.attemptId,
        p_status: input.status,
        p_provider_request_id: input.providerRequestId ?? null,
        p_provider_attempt_id: input.providerAttemptId ?? null,
        p_error_code: boundedErrorCode(input.errorCode),
      } as never,
    );
    const result = data as unknown as { success?: boolean; code?: string } | null;
    if (error || result?.success !== true) {
      console.error("[bookingOtpDeliveryTruth] completion unavailable", {
        status: input.status,
        code: result?.code ?? "database_error",
      });
      return false;
    }
    return true;
  } catch {
    console.error("[bookingOtpDeliveryTruth] completion threw", { status: input.status });
    return false;
  }
}

export async function markBookingOtpDeliveryVerified(input: {
  salonId: string;
  channel: BookingOtpChannel;
  recipient: string;
  attemptId: string;
}): Promise<boolean> {
  if (!isBookingOtpDeliveryAttemptId(input.attemptId)) return false;
  try {
    const db = createServiceRoleClient();
    const { data, error } = await db.rpc(
      "mark_booking_otp_delivery_verified" as never,
      {
        p_salon_id: input.salonId,
        p_channel: input.channel,
        p_recipient_fingerprint: bookingOtpRecipientFingerprint(input.recipient),
        p_attempt_id: input.attemptId,
      } as never,
    );
    return !error && typeof data === "string" && UUID_RE.test(data);
  } catch {
    return false;
  }
}

function boundedErrorCode(value: string | null | undefined): string | null {
  const clean = (value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .slice(0, 120)
    .trim();
  return clean || null;
}
