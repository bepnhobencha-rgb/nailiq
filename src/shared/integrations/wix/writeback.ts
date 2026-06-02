/**
 * NailIQ → Wix write-back. Call after a receptionist confirms/cancels a booking so the
 * change propagates to Wix. Best-effort and fire-and-forget: never throws, never blocks
 * the receptionist action — a Wix outage must not break the desk.
 *
 * Only acts on bookings that carry a `wix_booking_id` (i.e. originated from Wix) whose salon
 * has an enabled `wix_integrations` row.
 */
import "server-only";
import { confirmWixBooking, cancelWixBooking, declineWixBooking } from "./client";
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
