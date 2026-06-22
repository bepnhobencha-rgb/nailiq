/**
 * Square Appointments → NailIQ bookings backfill for Hi-Lite Studio (Westminster).
 * Adapted from backfill-square-bookings.ts — uses hilite-studio slug + full history.
 *
 *   npx tsx scripts/backfill-hilite-studio-bookings.ts --dry-run
 *   npx tsx scripts/backfill-hilite-studio-bookings.ts
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { getSquareConfig, listCatalogItems, listBookings, type SquareBooking } from "../src/shared/integrations/square/client";

const SALON_SLUG = "hilite-studio";
const DRY_RUN = process.argv.includes("--dry-run");
// Pull ALL history — go back 5 years, forward 90 days
const PAST_MONTHS = 60;
const FUTURE_DAYS = 90;

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const norm = (s: string) =>
  s.toLowerCase().replace(/^\s*\d+\s*[-.]\s*/, "").replace(/[^a-z0-9]/g, "");

// Square catalog names that differ from NailIQ service names
const SERVICE_ALIASES: Record<string, string> = {
  "hotoilhairtreatment": "hotoiltreatment",
  "hotstone":            "hotstoneaddon",
  "ledlighttherapy":     "ledlighttherapymask",
  "steameyemask":        "ledlighttherapymask",
  "steamedeyemask":      "ledlighttherapymask",
  "specialpk":           "hilitespecial",
  "deluxepk":            "hilitedeluxe",
};

const STATUS_MAP: Record<string, string> = {
  ACCEPTED: "confirmed",
  PENDING: "pending",
  CANCELLED_BY_CUSTOMER: "cancelled",
  CANCELLED_BY_SELLER: "cancelled",
  DECLINED: "cancelled",
  NO_SHOW: "no_show",
};

async function main() {
  console.log(`\n=== Square → NailIQ bookings backfill: ${SALON_SLUG} (${DRY_RUN ? "DRY RUN" : "WRITE"}) ===`);
  console.log(`Window: last ${PAST_MONTHS} months + next ${FUTURE_DAYS} days\n`);

  const { data: salon } = await db.from("salons").select("id, name").eq("slug", SALON_SLUG).maybeSingle();
  if (!salon) throw new Error(`Salon ${SALON_SLUG} not found`);
  const salonId = (salon as { id: string; name: string }).id;
  console.log(`Salon: ${(salon as { id: string; name: string }).name} (${salonId})`);

  const cfg = await getSquareConfig(db, salonId);
  console.log(`Square location: ${cfg.locationId}`);

  // Square catalog → variationId to item name
  console.log("\nLoading Square catalog...");
  const items = await listCatalogItems(cfg);
  const variationToItemName = new Map<string, string>();
  for (const it of items) for (const v of it.variations) variationToItemName.set(v.id, it.name);
  console.log(`  ${variationToItemName.size} catalog variations loaded`);

  // NailIQ services for this salon
  const { data: svcRows } = await db
    .from("services").select("id, name, price_cents")
    .eq("salon_id", salonId).is("deleted_at", null);
  const svcByNorm = new Map<string, { id: string; price_cents: number }>();
  for (const s of (svcRows as { id: string; name: string; price_cents: number }[]) ?? [])
    svcByNorm.set(norm(s.name), { id: s.id, price_cents: s.price_cents });
  console.log(`  ${svcByNorm.size} NailIQ services loaded`);

  // Pull Square bookings
  const now = new Date();
  const begin = new Date(now.getFullYear(), now.getMonth() - PAST_MONTHS, now.getDate());
  const end   = new Date(now.getTime() + FUTURE_DAYS * 86_400_000);
  console.log(`\nPulling Square bookings from ${begin.toDateString()} to ${end.toDateString()}...`);
  const bookings = await listBookings(cfg, begin, end);
  console.log(`  Fetched ${bookings.length} bookings`);

  // Map Square customer_id → NailIQ profile
  const customerIds = [...new Set(bookings.map((b) => b.customer_id).filter(Boolean) as string[])];
  const clientBySqId = new Map<string, { name: string | null; phone: string; profile_id: string }>();
  for (let i = 0; i < customerIds.length; i += 300) {
    const { data } = await db
      .from("client_profiles").select("id, square_customer_id, name, phone")
      .in("square_customer_id", customerIds.slice(i, i + 300));
    for (const r of (data as { id: string; square_customer_id: string; name: string | null; phone: string }[]) ?? [])
      clientBySqId.set(r.square_customer_id, { name: r.name, phone: r.phone, profile_id: r.id });
  }
  console.log(`  Matched ${clientBySqId.size}/${customerIds.length} customers to NailIQ profiles`);

  let noService = 0, noClient = 0, noTime = 0;
  const rows: Record<string, unknown>[] = [];
  const statusTally: Record<string, number> = {};

  for (const b of bookings as SquareBooking[]) {
    statusTally[b.status] = (statusTally[b.status] ?? 0) + 1;
    const seg = b.appointment_segments?.[0];
    const itemName = seg?.service_variation_id ? variationToItemName.get(seg.service_variation_id) : undefined;
    const normName = itemName ? norm(itemName) : undefined;
    const resolvedName = normName ? (SERVICE_ALIASES[normName] ?? normName) : undefined;
    const svc = resolvedName ? svcByNorm.get(resolvedName) : undefined;
    if (!svc) { noService++; continue; }
    if (!b.start_at) { noTime++; continue; }
    const client = b.customer_id ? clientBySqId.get(b.customer_id) : undefined;
    if (!client) { noClient++; continue; }

    const durMin = (b.appointment_segments ?? []).reduce((s, x) => s + (x.duration_minutes ?? 0), 0) || 60;
    const start = new Date(b.start_at);
    const endT  = new Date(start.getTime() + durMin * 60_000);
    let status = STATUS_MAP[b.status] ?? "completed";
    if (status === "confirmed" && start < now) status = "completed";

    rows.push({
      salon_id:           salonId,
      service_id:         svc.id,
      staff_id:           null,
      resource_id:        null,
      client_profile_id:  client.profile_id,
      client_name:        client.name || "Square Guest",
      client_phone:       client.phone,
      start_time_utc:     start.toISOString(),
      end_time_utc:       endT.toISOString(),
      status,
      source:             "appointment",
      booking_channel:    "square",
      price_cents:        svc.price_cents,
      square_booking_id:  b.id,
    });
  }

  const futureN = rows.filter((r) => new Date(r.start_time_utc as string) >= now).length;
  console.log(`\n--- SUMMARY ---`);
  console.log(`  Total fetched:        ${bookings.length}`);
  console.log(`  Status breakdown:     ${JSON.stringify(statusTally)}`);
  console.log(`  Unmapped service:     ${noService}`);
  console.log(`  Client not found:     ${noClient}`);
  console.log(`  Missing time:         ${noTime}`);
  console.log(`  RESOLVED to insert:   ${rows.length}`);
  console.log(`    Future (calendar):  ${futureN}`);
  console.log(`    Past (history):     ${rows.length - futureN}`);

  if (DRY_RUN) {
    console.log(`\nSample (first 10 future):`);
    const future = rows.filter((r) => new Date(r.start_time_utc as string) >= now);
    for (const r of future.slice(0, 10)) {
      console.log(`  ${(r.start_time_utc as string).slice(0, 16)}  ${String(r.status).padEnd(9)}  ${r.client_name}  $${(r.price_cents as number) / 100}`);
    }
    console.log(`\n⚠️  DRY RUN — no writes. Re-run without --dry-run to insert ${rows.length} bookings.`);
    return;
  }

  // Dedup within fetched data (Square API can return same booking twice across page boundaries)
  const seenIds = new Set<string>();
  const dedupedRows = rows.filter((r) => {
    const id = r.square_booking_id as string;
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
  console.log(`  Deduped: ${rows.length} → ${dedupedRows.length}`);

  // Idempotency: skip already-imported square_booking_ids
  const existing = new Set<string>();
  for (let i = 0; i < dedupedRows.length; i += 300) {
    const ids = dedupedRows.slice(i, i + 300).map((r) => r.square_booking_id as string);
    const { data } = await db.from("bookings").select("square_booking_id").in("square_booking_id", ids);
    for (const r of (data as { square_booking_id: string }[]) ?? []) existing.add(r.square_booking_id);
  }
  const toInsert = dedupedRows.filter((r) => !existing.has(r.square_booking_id as string));
  console.log(`\nInserting ${toInsert.length} bookings (${existing.size} already imported, skipped)...`);

  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += 200) {
    const chunk = toInsert.slice(i, i + 200);
    const { data, error } = await db.from("bookings").insert(chunk).select("id");
    if (error) throw new Error(`Insert chunk @${i}: ${JSON.stringify(error)}`);
    inserted += (data as unknown[])?.length ?? 0;
    process.stdout.write(`  ${inserted}/${toInsert.length} inserted...\r`);
  }
  console.log(`\n✅ Done — ${inserted} bookings imported.\n`);
}

main().catch((e) => { console.error("\nFAILED:", e); process.exit(1); });
