import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

export type ReminderType = "24h" | "3h";
export type ReminderChannel = "email" | "sms";
export type ReminderDeliveryStatus =
  | "sent"
  | "failed"
  | "unknown"
  | "suppressed";

type ProviderResult = {
  ok: boolean;
  outcome?: "accepted" | "suppressed" | "rejected" | "unknown";
  messageId?: string;
  messageSid?: string;
  error?: string;
  suppressed?: boolean;
  suppressionReason?: string;
};

export type ReminderDeliveryClaim =
  | { ok: true; claimed: true; claimId: string }
  | { ok: true; claimed: false; status: string }
  | { ok: false; error: "claim_unavailable" | "invalid_claim_response" };

export async function claimReminderDelivery(input: {
  salonId: string;
  bookingId: string;
  appointmentStartUtc: string;
  reminderType: ReminderType;
  channel: ReminderChannel;
}): Promise<ReminderDeliveryClaim> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "claim_booking_reminder_delivery" as never,
    {
      p_salon_id: input.salonId,
      p_booking_id: input.bookingId,
      p_appointment_start_utc: input.appointmentStartUtc,
      p_reminder_type: input.reminderType,
      p_channel: input.channel,
    } as never,
  );
  if (error) return { ok: false, error: "claim_unavailable" };
  const result = data as unknown as Record<string, unknown> | null;
  if (result?.success !== true) {
    return { ok: false, error: "invalid_claim_response" };
  }
  if (result.claimed !== true) {
    return {
      ok: true,
      claimed: false,
      status: typeof result.status === "string" ? result.status : "unknown",
    };
  }
  if (typeof result.claim_id !== "string" || result.claim_id.length < 20) {
    return { ok: false, error: "invalid_claim_response" };
  }
  return { ok: true, claimed: true, claimId: result.claim_id };
}

export function classifyReminderProviderResult(
  result: ProviderResult,
  channel: ReminderChannel,
): {
  status: ReminderDeliveryStatus;
  providerMessageId: string | null;
  errorCode: string | null;
} {
  const providerMessageId = (result.messageId ?? result.messageSid ?? "").trim();
  if (result.outcome === "suppressed") {
    return {
      status: "suppressed",
      providerMessageId: null,
      errorCode: result.suppressionReason
        ? `delivery_suppressed:${result.suppressionReason}`
        : "delivery_suppressed",
    };
  }
  if (result.outcome === "unknown") {
    return {
      status: "unknown",
      providerMessageId: null,
      errorCode: "provider_outcome_unknown",
    };
  }
  if (result.ok) {
    if (result.suppressed === true) {
      return {
        status: "suppressed",
        providerMessageId: null,
        errorCode: result.suppressionReason
          ? `delivery_suppressed:${result.suppressionReason}`
          : "delivery_suppressed",
      };
    }
    if (providerMessageId === "") {
      return {
        status: "unknown",
        providerMessageId: null,
        errorCode: "provider_receipt_missing",
      };
    }
    if (
      (channel === "sms" && !/^(?:SM|MM)[0-9a-f]{32}$/iu.test(providerMessageId)) ||
      (channel === "email" &&
        (providerMessageId.length > 200 || /[\u0000-\u001f\u007f]/u.test(providerMessageId)))
    ) {
      return {
        status: "unknown",
        providerMessageId: null,
        errorCode: "invalid_provider_receipt",
      };
    }
    return { status: "sent", providerMessageId, errorCode: null };
  }

  const error = String(result.error ?? "").trim().toLowerCase();
  const knownPreflightFailure =
    error === "invalid_phone" ||
    error === "sms_consent_unavailable" ||
    error === "sms_delivery_truth_unavailable" ||
    error === "status_callback_unavailable" ||
    error === "twilio_not_configured" ||
    error === "resend_not_configured" ||
    /^twilio_4\d\d$/u.test(error) ||
    /^resend_4\d\d$/u.test(error);
  return knownPreflightFailure
    ? {
        status: "failed",
        providerMessageId: null,
        errorCode: "delivery_preflight_or_rejection_failed",
      }
    : {
        status: "unknown",
        providerMessageId: null,
        errorCode: "provider_outcome_unknown",
      };
}

export async function completeReminderDelivery(input: {
  claimId: string;
  status: ReminderDeliveryStatus;
  providerMessageId?: string | null;
  errorCode?: string | null;
}): Promise<boolean> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "complete_booking_reminder_delivery" as never,
    {
      p_claim_id: input.claimId,
      p_status: input.status,
      p_provider_message_id: input.providerMessageId ?? null,
      p_error_code: input.errorCode ?? null,
    } as never,
  );
  if (error) return false;
  const result = data as unknown as Record<string, unknown> | null;
  return (
    result?.success === true &&
    (result.code === "completed" || result.code === "already_completed")
  );
}
