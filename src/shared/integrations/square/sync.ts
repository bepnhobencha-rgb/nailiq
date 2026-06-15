/**
 * Square -> NailIQ forward sync (stateless; called by the Vercel cron).
 *
 * Each run pulls the location's bookings in a rolling window (yesterday ..
 * +90 days) and reconciles them into NailIQ:
 *   - new active booking      -> insert, assigned to its Square bed's NailIQ
 *                                staff (square_team_member_id link) or any free
 *                                column (so it renders + never violates the
 *                                bookings_no_overlap GIST).
 *   - status/time change      -> update the existing row (cancellations,
 *                                reschedules, no-shows reflected on the calendar).
 *   - unknown customer        -> fetched on demand and inserted into
 *                                client_profiles (canonical phone), so returning
 *                                customers are recognised.
 *
 * Idempotent on bookings.square_booking_id / client_profiles.square_customer_id.
 * ListBookings has no "updated since" filter, so we re-scan the forward window
 * each run and upsert; the watermark is advanced for observability only.
 */
import "server-only";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";
import { sendOwnerBookingNotification } from "@/shared/dashboard/sendOwnerBookingNotification";
import { looseServiceClient } from "./looseDb";
import {
  getSquareConfig,
  listBookings,
  listCatalogItems,
  getCustomer,
  type SquareBooking,
} from "./client";

const RENDER_STATUS = new Set(["pending", "confirmed", "in_progress", "completed"]);
const STATUS_MAP: Record<string, string> = {
  ACCEPTED: "confirmed",
  PENDING: "pending",
  CANCELLED_BY_CUSTOMER: "cancelled",
  CANCELLED_BY_SELLER: "cancelled",
  DECLINED: "cancelled",
  NO_SHOW: "no_show",
};
const norm = (s: string) => s.toLowerCase().replace(/^\s*\d+\s*[-.]\s*/, "").replace(/[^a-z0-9]/g, "");
const safeName = (s: string) => s.replace(/&/g, "and").replace(/[<>{}=;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
const overlaps = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;
const str = (v: unknown): string => (v == null ? "" : String(v));

export interface SquareSyncResult {
  pulled: number;
  inserted: number;
  updated: number;
  customersAdded: number;
  skipped: number;
}

/** Find an active bed/staff with no rendered booking overlapping [startMs,endMs)
 *  — used to re-home a Square-rescheduled booking whose new time collides with
 *  its current bed (bookings_no_overlap GIST). Returns null when every bed is
 *  busy at the new slot. */
async function findFreeStaffForInterval(
  db: ReturnType<typeof looseServiceClient>,
  salonId: string,
  activeStaff: string[],
  startMs: number,
  endMs: number,
  excludeBookingId: string,
): Promise<string | null> {
  const { data } = await db
    .from("bookings")
    .select("staff_id, status")
    .eq("salon_id", salonId)
    .not("id", "eq", excludeBookingId)
    .not("staff_id", "is", null)
    .lt("start_time_utc", new Date(endMs).toISOString())
    .gt("end_time_utc", new Date(startMs).toISOString());
  const busy = new Set<string>();
  for (const r of data ?? []) if (RENDER_STATUS.has(str(r.status))) busy.add(str(r.staff_id));
  for (const sid of activeStaff) if (!busy.has(sid)) return sid;
  return null;
}

export async function runSquareForwardSync(salonId: string): Promise<SquareSyncResult> {
  const db = looseServiceClient();
  const cfg = await getSquareConfig(db, salonId);

  const now = new Date();
  const begin = new Date(now.getTime() - 86_400_000);
  const end = new Date(now.getTime() + 90 * 86_400_000);
  const bookings = (await listBookings(cfg, begin, end)) as SquareBooking[];

  // service variation -> NailIQ service
  const items = await listCatalogItems(cfg);
  const variationToItemName = new Map<string, string>();
  for (const it of items) for (const v of it.variations) variationToItemName.set(v.id, it.name);
  const { data: svcRows } = await db.from("services").select("id, name, price_cents").eq("salon_id", salonId).is("deleted_at", null);
  const svcByNorm = new Map<string, { id: string; price_cents: number }>();
  for (const s of svcRows ?? []) svcByNorm.set(norm(str(s.name)), { id: str(s.id), price_cents: Number(s.price_cents) });

  // staff: square bed link + occupancy for free-column fallback
  const { data: staffRows } = await db.from("staff").select("id, square_team_member_id").eq("salon_id", salonId).eq("status", "active").is("deleted_at", null);
  const activeStaff: string[] = (staffRows ?? []).map((s) => str(s.id));
  const tmToStaff = new Map<string, string>();
  for (const s of staffRows ?? []) if (s.square_team_member_id) tmToStaff.set(str(s.square_team_member_id), str(s.id));

  const occ = new Map<string, [number, number][]>();
  for (const id of activeStaff) occ.set(id, []);
  const { data: occRows } = await db
    .from("bookings").select("staff_id, start_time_utc, end_time_utc, status")
    .eq("salon_id", salonId).not("staff_id", "is", null).gte("start_time_utc", begin.toISOString()).lt("start_time_utc", end.toISOString());
  for (const r of occRows ?? [])
    if (RENDER_STATUS.has(str(r.status)) && occ.has(str(r.staff_id))) occ.get(str(r.staff_id))!.push([Date.parse(str(r.start_time_utc)), Date.parse(str(r.end_time_utc))]);

  let inserted = 0, updated = 0, customersAdded = 0, skipped = 0;
  // Owner-notify guard: cap emails per sync run so a bulk import can't storm.
  const OWNER_NOTIFY_CAP = 5;
  let ownerNotifyCount = 0;
  const clientCache = new Map<string, { name: string | null; phone: string | null }>();

  for (const b of bookings) {
    const seg = b.appointment_segments?.[0];
    const itemName = seg?.service_variation_id ? variationToItemName.get(seg.service_variation_id) : undefined;
    const svc = itemName ? svcByNorm.get(norm(itemName)) : undefined;
    if (!svc || !b.start_at) { skipped++; continue; }

    const targetStatus = STATUS_MAP[b.status] ?? "completed";

    // resolve / import client
    let client = b.customer_id ? clientCache.get(b.customer_id) : undefined;
    if (!client && b.customer_id) {
      const { data: existingClient } = await db.from("client_profiles").select("name, phone").eq("square_customer_id", b.customer_id).maybeSingle();
      if (existingClient) {
        client = { name: existingClient.name ? str(existingClient.name) : null, phone: existingClient.phone ? str(existingClient.phone) : null };
      } else {
        const sc = await getCustomer(cfg, b.customer_id);
        const phone = toCanonicalPhone(sc?.phone_number);
        const nm = safeName([sc?.given_name ?? "", sc?.family_name ?? ""].join(" "));
        if (sc && phone) {
          // Returning customer may already exist by phone (from the backfill) but
          // unlinked — link it (set square_customer_id) instead of re-fetching forever.
          const { data: byPhone } = await db.from("client_profiles").select("id, name, square_customer_id").eq("phone", phone).maybeSingle();
          if (byPhone) {
            if (!byPhone.square_customer_id) await db.from("client_profiles").update({ square_customer_id: sc.id }).eq("id", str(byPhone.id));
            client = { name: byPhone.name ? str(byPhone.name) : nm || null, phone };
          } else {
            await db.from("client_profiles").insert({ phone, name: nm || null, email: (sc.email_address ?? "").trim().toLowerCase() || null, square_customer_id: sc.id });
            customersAdded++;
            client = { name: nm || null, phone };
          }
        } else {
          client = { name: nm || null, phone };
        }
      }
      clientCache.set(b.customer_id, client);
    }

    const durMin = (b.appointment_segments ?? []).reduce((s, x) => s + (x.duration_minutes ?? 0), 0) || 60;
    const startMs = Date.parse(b.start_at);
    const endMs = startMs + durMin * 60_000;

    const { data: existing } = await db
      .from("bookings")
      .select("id, status, start_time_utc, end_time_utc, staff_id")
      .eq("square_booking_id", b.id)
      .maybeSingle();

    if (existing) {
      // The desk owns the workflow status once a booking has been started,
      // completed, or no-showed in NailIQ — Square (which only knows ACCEPTED)
      // must NOT clobber it back to "confirmed" on the next sync. (Bug: a
      // receptionist-completed Square booking reverted to "not started".)
      // Square's own state still applies while the booking is pending/confirmed.
      const localStatus = str(existing.status);
      const existingId = str(existing.id);
      const deskOwned =
        localStatus === "in_progress" ||
        localStatus === "completed" ||
        localStatus === "no_show";

      const updates: Record<string, unknown> = {};
      if (!deskOwned && localStatus !== targetStatus) {
        updates.status = targetStatus;
      }

      // RESCHEDULE sync (Square → NailIQ): Square's ListBookings has no
      // "updated since" filter, so a time change on an EXISTING booking was
      // never reflected — the row kept its original time and the desk saw the
      // wrong slot. Update start/end when Square's time moved, but only for a
      // booking the desk hasn't taken over and that's still active (a cancelled
      // booking's time is moot).
      const newStart = new Date(startMs).toISOString();
      const newEnd = new Date(endMs).toISOString();
      // Compare by instant (ms), not string — the DB returns timestamptz as
      // "2026-06-15 19:30:00+00" while newStart is ISO "…T19:30:00.000Z"; a
      // string compare would read every booking as moved and rewrite it each run.
      const timeMoved =
        Date.parse(str(existing.start_time_utc)) !== startMs ||
        Date.parse(str(existing.end_time_utc)) !== endMs;
      if (!deskOwned && RENDER_STATUS.has(targetStatus) && timeMoved) {
        updates.start_time_utc = newStart;
        updates.end_time_utc = newEnd;
      }

      if (Object.keys(updates).length > 0) {
        const { error } = await db.from("bookings").update(updates).eq("id", existingId);
        if (error) {
          // A time move can collide with another booking on the same bed
          // (bookings_no_overlap GIST → 23P01). Re-home it to any active bed
          // free at the NEW slot; if none, leave the row as-is (never crash the
          // whole sync run for one conflict).
          if (updates.start_time_utc) {
            const freeStaff = await findFreeStaffForInterval(
              db, salonId, activeStaff, startMs, endMs, existingId,
            );
            if (freeStaff) {
              const { error: e2 } = await db
                .from("bookings")
                .update({ ...updates, staff_id: freeStaff })
                .eq("id", existingId);
              if (!e2) updated++;
              else skipped++;
            } else {
              skipped++;
            }
          } else {
            skipped++;
          }
        } else {
          updated++;
        }
      }
      continue;
    }

    // new booking: only materialise active ones (skip brand-new already-cancelled)
    if (!RENDER_STATUS.has(targetStatus)) { skipped++; continue; }

    const preferred = seg?.team_member_id ? tmToStaff.get(seg.team_member_id) : undefined;
    const order = preferred ? [preferred, ...activeStaff.filter((x) => x !== preferred)] : activeStaff;
    let staffId: string | null = null;
    for (const sid of order) {
      const iv = occ.get(sid)!;
      if (!iv.some(([os, oe]) => overlaps(startMs, endMs, os, oe))) { staffId = sid; iv.push([startMs, endMs]); break; }
    }
    if (!staffId) { skipped++; continue; } // > all beds busy

    const { data: insRow, error } = await db.from("bookings").insert({
      salon_id: salonId,
      service_id: svc.id,
      staff_id: staffId,
      client_name: client?.name || "Square Guest",
      client_phone: client?.phone ?? null,
      start_time_utc: new Date(startMs).toISOString(),
      end_time_utc: new Date(endMs).toISOString(),
      status: targetStatus,
      source: "appointment",
      // booking_channel not yet in generated types — cast below.
      booking_channel: "square",
      price_cents: svc.price_cents,
      square_booking_id: b.id,
    } as never).select("id").maybeSingle();
    if (error) { skipped++; continue; }
    inserted++;

    // Owner/admin "new booking" alert — only future bookings, capped per run so
    // a bulk historical import can't blast a storm of emails.
    const newId = (insRow as { id?: string } | null)?.id;
    if (newId && startMs > Date.now() && ownerNotifyCount < OWNER_NOTIFY_CAP) {
      ownerNotifyCount++;
      void sendOwnerBookingNotification({
        salonId,
        bookingId: String(newId),
        event: "new",
      });
    }
  }

  await db.from("square_integrations").update({
    cursor_synced_at: now.toISOString(),
    last_run_at: now.toISOString(),
    last_error: null,
  }).eq("salon_id", salonId);

  return { pulled: bookings.length, inserted, updated, customersAdded, skipped };
}
