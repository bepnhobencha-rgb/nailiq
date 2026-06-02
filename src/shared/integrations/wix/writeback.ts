/**
 * NailIQ → Wix write-back. Call after a receptionist confirms/cancels a booking so the
 * change propagates to Wix. Best-effort and fire-and-forget: never throws, never blocks
 * the receptionist action — a Wix outage must not break the desk.
 *
 * Only acts on bookings that carry a `wix_booking_id` (i.e. originated from Wix) whose salon
 * has an enabled `wix_integrations` row.
 */
import "server-only";
import { confirmWixBooking, cancelWixBooking, declineWixBooking, createWixBooking } from "./client";
import { looseServiceClient } from "./looseDb";

async function resolve(salonId: string, bookingId: string): Promise<{ siteId: string; wixId: string } | null> {
  const db = looseServiceClient();
  const { data: integ } = await db.from("wix_integrations").select("site_id").eq("salon_id", salonId).eq("enabled", true).maybeSingle();
  if (!integ?.site_id) return null;
  const { data: bk } = await db.from("bookings").select("wix_booking_id").eq("id", bookingId).maybeSingle();
  if (!bk?.wix_booking_id) return null;
  return { siteId: integ.site_id as string, wixId: bk.wix_booking_id as string };
}

export async function pushWixCancel(salonId: string, bookingId: string): Promise<void> {
  try {
    const r = await resolve(salonId, bookingId);
    if (!r) return;
    await cancelWixBooking(r.siteId, r.wixId);
  } catch (e) {
    console.error("[wix writeback] cancel", bookingId, (e as Error).message);
  }
}

export async function pushWixConfirm(salonId: string, bookingId: string): Promise<void> {
  try {
    const r = await resolve(salonId, bookingId);
    if (!r) return;
    await confirmWixBooking(r.siteId, r.wixId);
  } catch (e) {
    console.error("[wix writeback] confirm", bookingId, (e as Error).message);
  }
}

export async function pushWixDecline(salonId: string, bookingId: string): Promise<void> {
  try {
    const r = await resolve(salonId, bookingId);
    if (!r) return;
    await declineWixBooking(r.siteId, r.wixId);
  } catch (e) {
    console.error("[wix writeback] decline", bookingId, (e as Error).message);
  }
}

/**
 * Push a newly-created NailIQ booking to Wix so it appears on the Wix calendar.
 * Best-effort: any failure is logged but does NOT throw (booking already exists in NailIQ).
 * On success, stores the returned Wix booking ID on the NailIQ booking row so that the
 * forward sync never creates a duplicate on the next poll.
 * Uses skipAvailabilityValidation + skipBusinessConfirmation to bypass Wix schedule checks.
 * notifyParticipants: false — NailIQ already sends SMS/email.
 */
export async function pushWixCreate(salonId: string, bookingId: string): Promise<void> {
  try {
    const db = looseServiceClient();

    // 1. Check salon has an enabled wix_integrations row.
    const { data: rawInteg } = await db
      .from("wix_integrations")
      .select("site_id, wix_location_id")
      .eq("salon_id", salonId)
      .eq("enabled", true)
      .maybeSingle();
    const integ = rawInteg as { site_id?: string; wix_location_id?: string | null } | null;
    if (!integ?.site_id) return; // no Wix integration for this salon

    // 2. Fetch the NailIQ booking row.
    const { data: rawBk } = await db
      .from("bookings")
      .select("id, service_id, staff_id, start_time_utc, end_time_utc, client_name, client_phone, client_email, wix_booking_id")
      .eq("id", bookingId)
      .maybeSingle();
    const bk = rawBk as {
      id: string;
      service_id: string | null;
      staff_id: string | null;
      start_time_utc: string | null;
      end_time_utc: string | null;
      client_name: string | null;
      client_phone: string | null;
      client_email: string | null;
      wix_booking_id: string | null;
    } | null;
    if (!bk) return;
    // Skip if already linked to Wix (already synced or created from Wix).
    if (bk.wix_booking_id) return;
    if (!bk.start_time_utc || !bk.end_time_utc) return;

    // 3. Fetch salon timezone.
    const { data: rawSalon } = await db
      .from("salons")
      .select("timezone")
      .eq("id", salonId)
      .maybeSingle();
    const timezone = (rawSalon as { timezone?: string | null } | null)?.timezone ?? "America/Vancouver";

    // 4. Fetch service Wix IDs (added by migration 20260602100000 — not yet in generated types).
    const { data: rawSvc } = await db
      .from("services")
      .select("wix_service_id, wix_schedule_id")
      .eq("id", bk.service_id ?? "")
      .maybeSingle();
    const svc = rawSvc as { wix_service_id?: string | null; wix_schedule_id?: string | null } | null;
    if (!svc?.wix_service_id || !svc?.wix_schedule_id) {
      // Service has no Wix counterpart — cannot create on Wix.
      console.warn("[wix create] no wix_service_id/wix_schedule_id for booking", bookingId, "service", bk.service_id);
      return;
    }

    // 5. Fetch staff Wix resource ID (optional — skip if no staff assigned or not mapped yet).
    let wixResourceId: string | null = null;
    if (bk.staff_id) {
      const { data: rawStf } = await db
        .from("staff")
        .select("wix_resource_id")
        .eq("id", bk.staff_id)
        .maybeSingle();
      wixResourceId = (rawStf as { wix_resource_id?: string | null } | null)?.wix_resource_id ?? null;
    }

    // 6. Build Wix Create Booking payload.
    const slot: Record<string, unknown> = {
      serviceId:  svc.wix_service_id,
      scheduleId: svc.wix_schedule_id,
      startDate:  bk.start_time_utc,
      endDate:    bk.end_time_utc,
      timezone,
    };
    if (wixResourceId)          slot.resource  = { id: wixResourceId };
    if (integ.wix_location_id)  slot.location  = { id: integ.wix_location_id };

    // Split client_name into first/last (Wix requires separate fields).
    const nameParts  = (bk.client_name ?? "").trim().split(/\s+/);
    const firstName  = nameParts[0] ?? "Guest";
    const lastName   = nameParts.slice(1).join(" ") || undefined;

    const createBody: Record<string, unknown> = {
      booking: {
        bookedEntity: { slot },
        contactDetails: {
          firstName,
          ...(lastName             ? { lastName }             : {}),
          ...(bk.client_phone      ? { phone: bk.client_phone }  : {}),
          ...(bk.client_email      ? { email: bk.client_email }  : {}),
        },
      },
      flowControlSettings: {
        skipAvailabilityValidation: true,
        skipBusinessConfirmation:   true,
      },
      notifyParticipants: false,
    };

    // 7. Call Wix Create Booking API.
    const wixBookingId = await createWixBooking(integ.site_id, createBody);

    // 8. Store returned wix_booking_id so the forward sync never duplicates this booking.
    await db
      .from("bookings")
      .update({ wix_booking_id: wixBookingId } as never)
      .eq("id", bookingId);

    console.log(`[wix create] ✓ created wix booking ${wixBookingId} for nailiq ${bookingId}`);
  } catch (e) {
    // Best-effort — never throw (booking already exists in NailIQ).
    console.error("[wix create] error", bookingId, (e as Error).message);
  }
}
