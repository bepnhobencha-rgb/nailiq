import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import type { BookingWaitlistSource } from "@/shared/booking/waitlistSource";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import { createClient } from "@/shared/lib/supabase/client";

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
  /** Optional — required for email notifications when a slot opens. */
  clientEmail?: string;
  source: BookingWaitlistSource;
};

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

  const phoneOk = validateGuestPhone(clientPhone);
  if (!phoneOk.ok) {
    throw new Error("invalid_phone");
  }

  const nameTrimmed = clientName.trim();
  if (!isValidCustomerName(nameTrimmed)) {
    throw new Error("invalid_name_chars");
  }

  const supabase = createClient();

  const { data: salon, error: salonErr } = await supabase
    .from("salons")
    .select("id")
    .eq("slug", shopSlug)
    .single();

  if (salonErr || !salon) throw new Error("salon_not_found");

  const staffUuid =
    staffId === BOOKING_ANY_STAFF_ID || !staffId.trim()
      ? null
      : staffId;

  const { data: rpcRows, error: rpcErr } = await supabase.rpc(
    "create_public_waitlist_entry",
    {
      p_salon_id: salon.id,
      p_service_id: serviceId,
      p_staff_id: staffUuid,
      p_booking_date: bookingDateYmd,
      p_preferred_slot_label: preferredSlotLabel ?? "",
      p_client_name: nameTrimmed,
      p_client_phone: phoneOk.digits,
      p_source: source,
      p_client_email: clientEmail?.trim() || null,
    },
  );

  if (rpcErr) throw new Error(rpcErr.message ?? "waitlist_failed");

  const row = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  const wid =
    row &&
    typeof row === "object" &&
    "id" in row &&
    row.id != null
      ? String(row.id)
      : "";

  if (!wid) throw new Error("waitlist_empty");

  // Best-effort: notify the owner/admins that a customer joined the waitlist.
  // Never block or fail the join on this.
  try {
    const base =
      typeof window !== "undefined"
        ? ""
        : (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
    void fetch(`${base}/api/waitlist/notify-owner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ waitlistId: wid }),
    }).catch(() => {});
  } catch {
    /* ignore */
  }

  return { waitlistId: wid };
}
