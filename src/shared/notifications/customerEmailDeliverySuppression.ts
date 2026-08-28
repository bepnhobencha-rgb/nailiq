import "server-only";

import { createHash } from "node:crypto";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CustomerEmailDeliverySuppressionReason =
  | "suppressed"
  | "bounced"
  | "complained";

export function customerEmailRecipientFingerprint(email: string): string {
  return createHash("sha256")
    .update(email.trim().toLowerCase(), "utf8")
    .digest("hex");
}

/**
 * Provider-declared permanent suppression only. A lookup failure is not proof
 * that sending is safe, so callers receive `lookup_unavailable` and suppress
 * the provider call until the durable preflight can be checked again.
 */
export async function customerEmailDeliverySuppressionReason(input: {
  salonId: string;
  email: string;
}): Promise<CustomerEmailDeliverySuppressionReason | "lookup_unavailable" | null> {
  const email = input.email.trim().toLowerCase();
  if (!UUID_RE.test(input.salonId) || !email || email.length > 320 || !email.includes("@")) {
    return "lookup_unavailable";
  }
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "customer_email_delivery_suppression_reason" as never,
      {
        p_salon_id: input.salonId,
        p_recipient_fingerprint: customerEmailRecipientFingerprint(email),
      } as never,
    );
    if (error) return "lookup_unavailable";
    return data === "suppressed" || data === "bounced" || data === "complained"
      ? data
      : null;
  } catch {
    return "lookup_unavailable";
  }
}
