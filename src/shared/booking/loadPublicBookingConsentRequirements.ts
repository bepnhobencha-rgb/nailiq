import "server-only";

import {
  resolvePublicBookingConsentRequirements,
  type PublicBookingConsentRequirements,
} from "@/shared/booking/publicBookingConsentRequirements";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * Reads the salon's private operational switch and returns only the public-safe
 * consent requirement. The raw setting never enters the public catalog API.
 *
 * Fail closed for outbound messaging: if readiness cannot be verified, the
 * booking flow does not claim SMS consent or promise an SMS. Booking itself
 * remains available and the server-side SMS dispatcher retains its own hard
 * salon kill switch.
 */
export async function loadPublicBookingConsentRequirements(
  salonId: string,
): Promise<PublicBookingConsentRequirements> {
  try {
    const db = createServiceRoleClient();
    const { data, error } = await db
      .from("salons")
      .select("sms_outbound_enabled")
      .eq("id", salonId)
      .maybeSingle();

    if (error || !data) return resolvePublicBookingConsentRequirements(null);

    return resolvePublicBookingConsentRequirements({
      smsOutboundEnabled: data.sms_outbound_enabled,
    });
  } catch {
    return resolvePublicBookingConsentRequirements(null);
  }
}
