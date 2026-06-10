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

    const { data: existing } = await db.from("bookings").select("id, status").eq("square_booking_id", b.id).maybeSingle();

    if (existing) {
      if (str(existing.status) !== targetStatus) {
        await db.from("bookings").update({ status: targetStatus }).eq("id", str(existing.id));
        updated++;
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

    const { error } = await db.from("bookings").insert({
      salon_id: salonId,
      service_id: svc.id,
      staff_id: staffId,
      client_name: client?.name || "Square Guest",
      client_phone: client?.phone ?? null,
      start_time_utc: new Date(startMs).toISOString(),
      end_time_utc: new Date(endMs).toISOString(),
      status: targetStatus,
      source: "appointment",
      price_cents: svc.price_cents,
      square_booking_id: b.id,
    });
    if (error) { skipped++; continue; }
    inserted++;
  }

  await db.from("square_integrations").update({
    cursor_synced_at: now.toISOString(),
    last_run_at: now.toISOString(),
    last_error: null,
  }).eq("salon_id", salonId);

  return { pulled: bookings.length, inserted, updated, customersAdded, skipped };
}
