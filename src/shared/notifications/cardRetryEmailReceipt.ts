import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { customerEmailDeliverySuppressionReason, customerEmailRecipientFingerprint } from "./customerEmailDeliverySuppression";

export type CardRetryEmailLease = { id: string; attemptId: string; salonId: string };

/** No lease stealing or timeout retry: an interrupted sender may have sent. */
export async function claimCardRetryEmail(input: {
  salonId: string; bookingId: string; actorId: string | null; email: string;
}): Promise<CardRetryEmailLease | null> {
  if (!input.actorId || process.env.NODE_ENV !== "production"
    || ["1", "true", "yes"].includes((process.env.DISABLE_OUTBOUND_EMAIL ?? "").trim().toLowerCase())
    || process.env.DEMO_OTP === "true" || process.env.NEXT_PUBLIC_DEMO_OTP === "true") return null;
  try {
    if (await customerEmailDeliverySuppressionReason(input)) return null;
    const { data, error } = await createServiceRoleClient().rpc("claim_card_retry_email", {
      p_salon_id: input.salonId, p_booking_id: input.bookingId, p_actor_id: input.actorId,
      p_recipient_fingerprint: customerEmailRecipientFingerprint(input.email),
    });
    if (error || !data || data.state !== "claimed" || typeof data.id !== "string"
      || typeof data.attempt_id !== "string") return null;
    return { id: data.id, attemptId: data.attempt_id, salonId: input.salonId };
  } catch { return null; }
}

export async function completeCardRetryEmail(lease: CardRetryEmailLease, providerId: string | null): Promise<boolean> {
  try {
    const { data, error } = await createServiceRoleClient().rpc("complete_card_retry_email", {
      p_salon_id: lease.salonId, p_receipt_id: lease.id, p_attempt_id: lease.attemptId,
      p_provider_message_id: providerId,
    });
    return !error && data === true;
  } catch { return false; }
}
