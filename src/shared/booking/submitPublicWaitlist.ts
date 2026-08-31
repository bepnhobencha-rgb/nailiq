import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import type { BookingWaitlistSource } from "@/shared/booking/waitlistSource";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import { createPublicClient } from "@/shared/lib/supabase/publicClient";
import { submitCapacityRescueRequest } from "@/shared/booking/submitCapacityRescueRequest";

export type SubmitPublicWaitlistParams = {
  shopSlug: string;
  serviceId: string;
  /** Same localized labels as booking UI (e.g. `"9:00 AM"`); omit/null when no specific slot (whole-day wait). */
  preferredSlotLabel: string | null;
  /** Local calendar day `YYYY-MM-DD`. */
  bookingDateYmd: string;
  /** `"any"` or salon staff UUID. */
  staffId: string;
  clientName: string;
  clientPhone: string;
  /**
   * Required for public waitlist entries. Link-bearing SMS can be filtered by
   * carriers, so email is the dependable channel for the 20-minute claim link.
   */
  clientEmail: string;
  source: BookingWaitlistSource;
  /** Stable across retries. A changed payload with the same id is rejected. */
  requestId?: string;
  clientLocale?: "en" | "vi";
};

export function createPublicWaitlistRequestId(): string {
  return crypto.randomUUID();
}

export async function submitPublicWaitlistEntry(
  params: SubmitPublicWaitlistParams,
): Promise<{ waitlistId: string }> {
  const {
    shopSlug,
    serviceId,
    preferredSlotLabel,
    bookingDateYmd,
    staffId,
    clientName,
    clientPhone,
    clientEmail,
    source,
  } = params;

  const email = clientEmail.trim();
  if (!isValidEmailFormat(email)) {
    throw new Error("invalid_email");
  }

  const phoneOk = validateGuestPhone(clientPhone);
  if (!phoneOk.ok) {
    throw new Error("invalid_phone");
  }

  const nameTrimmed = clientName.trim();
  if (!isValidCustomerName(nameTrimmed)) {
    throw new Error("invalid_name_chars");
  }

  const supabase = createPublicClient();

  const { data: salonData, error: salonErr } = await supabase
    .from("public_salon_profiles" as never)
    .select("id")
    .eq("slug", shopSlug)
    .single();

  if (salonErr || !salonData) throw new Error("salon_not_found");
  const salon = salonData as unknown as { id: string };

  const staffUuid =
    staffId === BOOKING_ANY_STAFF_ID || !staffId.trim()
      ? null
      : staffId;

  const receipt = await submitCapacityRescueRequest({
    salonId: salon.id,
    requestId: params.requestId ?? createPublicWaitlistRequestId(),
    requestKind: "individual",
    primaryServiceId: serviceId,
    staffId: staffUuid,
    bookingDateYmd,
    preferredSlotLabel,
    partySize: 1,
    clientName: nameTrimmed,
    clientPhone: phoneOk.digits,
    clientEmail: email,
    clientLocale: params.clientLocale ?? "en",
    intent: {
      serviceIds: [serviceId],
      staffPreference: staffUuid ?? "any",
      source,
    },
  });
  const wid = receipt.requestId;

  // The database records the owner-notification intent atomically with the
  // Waitlist row. Provider delivery happens later through the leased worker;
  // the customer never waits for email and retries cannot duplicate it.

  return { waitlistId: wid };
}
