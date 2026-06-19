import "server-only";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

// Twilio: ~$0.0079 per SMS outbound (US standard)
const SMS_COST_USD_CENTS = 0.79; // 0.79 cents
// Resend: ~$0.001 per email (Pro plan)
const EMAIL_COST_USD_CENTS = 0.1; // 0.1 cents

export type ChannelCostSummary = {
  smsSent: number;
  emailSent: number;
  estimatedSmsUsdCents: number;
  estimatedEmailUsdCents: number;
};

/**
 * Aggregates per-channel send counts and estimated costs for a salon.
 * Only counts non-failed sends (status != 'failed') to avoid double-counting retries.
 *
 * @param salonId  Target salon
 * @param days     Look-back window (default 30)
 */
export async function getChannelCostSummary(
  salonId: string,
  days = 30,
): Promise<ChannelCostSummary> {
  const db = createServiceRoleClient();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const { data: rows, error } = await db
    .from("booking_notifications" as never)
    .select("channel, status")
    .eq("salon_id" as never, salonId)
    .neq("status" as never, "failed")
    .gte("created_at" as never, since);

  if (error) {
    console.error("[getChannelCostSummary] query", salonId, error);
    return {
      smsSent: 0,
      emailSent: 0,
      estimatedSmsUsdCents: 0,
      estimatedEmailUsdCents: 0,
    };
  }

  let smsSent = 0;
  let emailSent = 0;

  for (const r of (rows ?? []) as { channel: string; status: string }[]) {
    if (r.channel === "sms") smsSent++;
    else if (r.channel === "email") emailSent++;
  }

  return {
    smsSent,
    emailSent,
    estimatedSmsUsdCents: Math.round(smsSent * SMS_COST_USD_CENTS * 10) / 10,
    estimatedEmailUsdCents: Math.round(emailSent * EMAIL_COST_USD_CENTS * 10) / 10,
  };
}
