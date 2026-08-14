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
  const { data: bk } = await db
    .from("bookings")
    .select("wix_booking_id")
    .eq("id", bookingId)
    .eq("salon_id", salonId)
    .maybeSingle();
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
      .select("site_id, wix_location_id, wix_default_resource_id")
      .eq("salon_id", salonId)
      .eq("enabled", true)
      .maybeSingle();
    const integ = rawInteg as { site_id?: string; wix_location_id?: string | null; wix_default_resource_id?: string | null } | null;
    if (!integ?.site_id) return; // no Wix integration for this salon

    // 2. Fetch the NailIQ booking row.
    const { data: rawBk } = await db
      .from("bookings")
      .select("id, service_id, staff_id, start_time_utc, end_time_utc, client_name, client_phone, client_email, wix_booking_id")
      .eq("id", bookingId)
      .eq("salon_id", salonId)
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
      .select("name, wix_service_id, wix_schedule_id")
      .eq("id", bk.service_id ?? "")
      .eq("salon_id", salonId)
      .maybeSingle();
    const svc = rawSvc as { name?: string | null; wix_service_id?: string | null; wix_schedule_id?: string | null } | null;
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
        .eq("salon_id", salonId)
        .maybeSingle();
      wixResourceId = (rawStf as { wix_resource_id?: string | null } | null)?.wix_resource_id ?? null;
    }

    // 6. Build Wix Create Booking payload.
    // Normalize timestamps to strict ISO-8601 (`...Z`). PostgREST returns `+00:00`-suffixed
    // strings which Wix's slot validator can reject.
    const toIso = (s: string) => new Date(s).toISOString();
    const slot: Record<string, unknown> = {
      serviceId:  svc.wix_service_id,
      scheduleId: svc.wix_schedule_id,
      startDate:  toIso(bk.start_time_utc),
      endDate:    toIso(bk.end_time_utc),
      timezone,
    };
    // A Wix slot without a sessionId REQUIRES both resource.id and location.locationType.
    // Fall back to the salon's configured default resource when the assigned tech isn't mapped
    // to Wix (e.g. a NailIQ-only staff). Without any resource we cannot create — skip, don't guess.
    const resourceId = wixResourceId ?? integ.wix_default_resource_id ?? null;
    if (!resourceId) {
      console.warn("[wix create] no Wix resource for booking", bookingId, "staff", bk.staff_id, "— set wix_integrations.wix_default_resource_id");
      return;
    }
    slot.resource = { id: resourceId };
    slot.location = { locationType: "OWNER_BUSINESS" };

    // Split client_name into first/last (Wix requires separate fields).
    const nameParts  = (bk.client_name ?? "").trim().split(/\s+/);
    const firstName  = nameParts[0] ?? "Guest";
    const lastName   = nameParts.slice(1).join(" ") || undefined;

    const createBody: Record<string, unknown> = {
      booking: {
        bookedEntity: {
          slot,
          ...(svc.name ? { title: svc.name } : {}),
          tags: ["INDIVIDUAL"],
        },
        contactDetails: {
          firstName,
          ...(lastName             ? { lastName }             : {}),
          ...(bk.client_phone      ? { phone: bk.client_phone }  : {}),
          ...(bk.client_email      ? { email: bk.client_email }  : {}),
        },
        // Wix REQUIRES participantsChoices or totalParticipants — omitting it 400s the request.
        totalParticipants: 1,
        selectedPaymentOption: "OFFLINE",
      },
      // NailIQ already sends its own SMS/email; suppress Wix's. (Top-level notifyParticipants is
      // not a real field — the notification toggle lives under participantNotification.)
      participantNotification: { notifyParticipants: false },
      flowControlSettings: {
        skipAvailabilityValidation:          true,
        skipBusinessConfirmation:            true,
        skipSelectedPaymentOptionValidation: true,
      },
    };

    // 7. Call Wix Create Booking API.
    const wixBookingId = await createWixBooking(integ.site_id, createBody);

    // 8. Store returned wix_booking_id so the forward sync never duplicates this booking.
    await db
      .from("bookings")
      .update({ wix_booking_id: wixBookingId } as never)
      .eq("id", bookingId)
      .eq("salon_id", salonId)
      .in("status", ["pending", "confirmed"]);

    // 9. Confirm on Wix. Create Booking yields status CREATED (pending), which Wix parks in
    //    the "Booking Requests" inbox — NOT on the main calendar. A salon-originated booking is
    //    a real appointment, so confirm it immediately so it shows as a solid slot on Wix.
    //    Best-effort: if confirm fails the booking still exists (as CREATED) and the cron retries.
    try {
      await confirmWixBooking(integ.site_id, wixBookingId);
      console.log(`[wix create] ✓ created + confirmed wix booking ${wixBookingId} for nailiq ${bookingId}`);
    } catch (e) {
      console.warn(`[wix create] created ${wixBookingId} but confirm failed:`, (e as Error).message);
    }
  } catch (e) {
    // Best-effort — never throw (booking already exists in NailIQ).
    console.error("[wix create] error", bookingId, (e as Error).message);
  }
}

/**
 * Reconciliation safety-net: push NailIQ-origin bookings that *should* be on Wix but aren't yet.
 *
 * The immediate per-creation push (public booking page, walk-in queue, …) is best-effort and
 * fire-and-forget — it can be missed (client navigates away, a creation path that isn't wired,
 * a transient Wix error). Running this every cron cycle makes NailIQ→Wix eventually-consistent
 * regardless of *how* the booking was created. Idempotent: pushWixCreate stamps wix_booking_id,
 * so each booking is pushed at most once, and pushWixCreate's own guards skip anything unmappable.
 *
 * Scope is deliberately narrow to avoid retrying forever / pushing stale rows:
 *   - wix_booking_id IS NULL  (not already on Wix / not Wix-originated)
 *   - status in (confirmed, pending)  (active — never push cancelled/no_show/completed)
 *   - start_time_utc > now()  (Wix rejects past slots)
 *   - created_at within the last 24h  (a fresh miss; older ones need manual attention)
 */
export async function pushUnsyncedBookings(salonId: string, limit = 20): Promise<number> {
  try {
    const db = looseServiceClient();
    const nowIso = new Date().toISOString();
    const dayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data } = await db
      .from("bookings")
      .select("id")
      .eq("salon_id", salonId)
      .is("wix_booking_id", null)
      .in("status", ["confirmed", "pending"])
      .gt("start_time_utc", nowIso)
      .gt("created_at", dayAgoIso)
      .order("start_time_utc", { ascending: true })
      .limit(limit);
    const rows = (data ?? []) as { id: string }[];
    for (const r of rows) {
      // pushWixCreate is self-guarding + idempotent (skips unmapped service / already-linked).
      await pushWixCreate(salonId, r.id);
    }
    return rows.length;
  } catch (e) {
    console.error("[wix reconcile]", salonId, (e as Error).message);
    return 0;
  }
}
