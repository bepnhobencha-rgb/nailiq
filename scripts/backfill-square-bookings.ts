/**
 * Square Appointments -> NailIQ bookings backfill (Hi-Lite Anaheim).
 *
 * Maps each Square booking to a NailIQ booking:
 *   - service  : appointment_segment.service_variation_id -> Square item -> NailIQ
 *                service (matched by normalized name); price snapshot from NailIQ.
 *   - client   : booking.customer_id -> client_profiles.square_customer_id (already
 *                imported) -> name + phone.
 *   - staff    : imported UNASSIGNED (staff_id = null). Square "staff" are beds; null
 *                also sidesteps the bookings_no_overlap GIST exclusion.
 *   - time     : start_at + summed segment durations.
 *   - status   : Square status -> NailIQ status (past ACCEPTED -> completed).
 *
 * Idempotent on `square_booking_id`. Non-destructive (on-conflict-do-nothing).
 *
 *   npx tsx scripts/backfill-square-bookings.ts --dry-run [pastMonths=12] [futureDays=60]
 *   npx tsx scripts/backfill-square-bookings.ts          [pastMonths=12] [futureDays=60]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  getSquareConfig,
  listCatalogItems,
  listBookings,
  type SquareBooking,
} from "../src/shared/integrations/square/client";

const SALON_SLUG = "hilite-anaheim";
const DRY_RUN = process.argv.includes("--dry-run");
const args = process.argv.filter((a) => !a.startsWith("--") && /^\d+$/.test(a));
const PAST_MONTHS = Number(args[0] ?? 12);
const FUTURE_DAYS = Number(args[1] ?? 60);
const ROOT = resolve(__dirname, "..");

function loadEnv() {
  const raw = readFileSync(resolve(ROOT, ".env.local"), "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}
const env = loadEnv();
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Normalize service names so "5 - Hi Lite Classic" matches NailIQ "Hi Lite Classic".
const norm = (s: string) =>
  s.toLowerCase().replace(/^\s*\d+\s*[-.]\s*/, "").replace(/[^a-z0-9]/g, "");

const STATUS_MAP: Record<string, string> = {
  ACCEPTED: "confirmed",
  PENDING: "pending",
  CANCELLED_BY_CUSTOMER: "cancelled",
  CANCELLED_BY_SELLER: "cancelled",
  DECLINED: "cancelled",
  NO_SHOW: "no_show",
};

async function main() {
  console.log(`\n=== Square -> NailIQ bookings backfill (${DRY_RUN ? "DRY RUN" : "WRITE"}) ===`);
  console.log(`Window: last ${PAST_MONTHS} months + next ${FUTURE_DAYS} days\n`);

  const { data: salon } = await db.from("salons").select("id, name").eq("slug", SALON_SLUG).maybeSingle();
  if (!salon) throw new Error(`Salon ${SALON_SLUG} not found`);
  const salonId = (salon as { id: string }).id;
  const cfg = await getSquareConfig(db, salonId);

  // 1. Square catalog: variationId -> { itemName }
  const items = await listCatalogItems(cfg);
  const variationToItemName = new Map<string, string>();
  for (const it of items) for (const v of it.variations) variationToItemName.set(v.id, it.name);

  // 2. NailIQ services: normalized name -> { id, price_cents }
  const { data: svcRows } = await db
    .from("services")
    .select("id, name, price_cents")
    .eq("salon_id", salonId)
    .is("deleted_at", null);
  const svcByNorm = new Map<string, { id: string; price_cents: number }>();
  for (const s of (svcRows as { id: string; name: string; price_cents: number }[]) ?? [])
    svcByNorm.set(norm(s.name), { id: s.id, price_cents: s.price_cents });

  // 3. Pull Square bookings across the window.
  const now = new Date();
  const begin = new Date(now.getFullYear(), now.getMonth() - PAST_MONTHS, now.getDate());
  const end = new Date(now.getTime() + FUTURE_DAYS * 86_400_000);
  console.log(`Pulling Square bookings…`);
  const bookings = await listBookings(cfg, begin, end);
  console.log(`  fetched ${bookings.length} bookings`);

  // 4. Resolve each booking.
  const customerIds = [...new Set(bookings.map((b) => b.customer_id).filter(Boolean) as string[])];
  const clientBySquareId = new Map<string, { name: string | null; phone: string }>();
  for (let i = 0; i < customerIds.length; i += 300) {
    const chunk = customerIds.slice(i, i + 300);
    const { data } = await db
      .from("client_profiles")
      .select("square_customer_id, name, phone")
      .in("square_customer_id", chunk);
    for (const r of (data as { square_customer_id: string; name: string | null; phone: string }[]) ?? [])
      clientBySquareId.set(r.square_customer_id, { name: r.name, phone: r.phone });
  }

  let noService = 0, noClient = 0, noTime = 0;
  const rows: Record<string, unknown>[] = [];
  const statusTally: Record<string, number> = {};
  for (const b of bookings as SquareBooking[]) {
    statusTally[b.status] = (statusTally[b.status] ?? 0) + 1;
    const seg = b.appointment_segments?.[0];
    const itemName = seg?.service_variation_id ? variationToItemName.get(seg.service_variation_id) : undefined;
    const svc = itemName ? svcByNorm.get(norm(itemName)) : undefined;
    if (!svc) { noService++; continue; }
    if (!b.start_at) { noTime++; continue; }
    const client = b.customer_id ? clientBySquareId.get(b.customer_id) : undefined;
    if (!client) { noClient++; continue; }

    const durMin = (b.appointment_segments ?? []).reduce((s, x) => s + (x.duration_minutes ?? 0), 0) || 60;
    const start = new Date(b.start_at);
    const endT = new Date(start.getTime() + durMin * 60_000);
    let status = STATUS_MAP[b.status] ?? "completed";
    if (status === "confirmed" && start < now) status = "completed";

    rows.push({
      salon_id: salonId,
      service_id: svc.id,
      staff_id: null,
      client_name: client.name || "Square Guest",
      client_phone: client.phone,
      start_time_utc: start.toISOString(),
      end_time_utc: endT.toISOString(),
      status,
      source: "appointment",
      price_cents: svc.price_cents,
      square_booking_id: b.id,
    });
  }

  console.log(`\n--- SUMMARY ---`);
  console.log(`  Square bookings fetched ........... ${bookings.length}`);
  console.log(`  status breakdown .................. ${JSON.stringify(statusTally)}`);
  console.log(`  unmapped service (skip) ........... ${noService}`);
  console.log(`  client not imported (skip) ........ ${noClient}`);
  console.log(`  missing start time (skip) ......... ${noTime}`);
  console.log(`  RESOLVED -> to insert ............. ${rows.length}`);
  const futureN = rows.filter((r) => new Date(r.start_time_utc as string) >= now).length;
  console.log(`    future (calendar) ............... ${futureN}`);
  console.log(`    past (history) .................. ${rows.length - futureN}`);

  console.log(`\n--- SAMPLE (first 10) ---`);
  for (const r of rows.slice(0, 10)) {
    console.log(`  ${(r.start_time_utc as string).slice(0, 16)}  ${String(r.status).padEnd(9)} ${r.client_name}  (${r.client_phone})  $${(r.price_cents as number) / 100}`);
  }

  if (DRY_RUN) {
    console.log(`\nDRY RUN — no rows written. Re-run without --dry-run to insert ${rows.length} bookings.\n`);
    return;
  }

  // Idempotency: skip square_booking_ids already imported (partial unique index
  // can't be used as an ON CONFLICT arbiter via PostgREST, so filter here).
  const existing = new Set<string>();
  for (let i = 0; i < rows.length; i += 300) {
    const ids = rows.slice(i, i + 300).map((r) => r.square_booking_id as string);
    const { data } = await db.from("bookings").select("square_booking_id").in("square_booking_id", ids);
    for (const r of (data as { square_booking_id: string }[]) ?? []) existing.add(r.square_booking_id);
  }
  const toInsert = rows.filter((r) => !existing.has(r.square_booking_id as string));
  console.log(`\nInserting ${toInsert.length} new bookings (${existing.size} already imported, skipped)…`);
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += 500) {
    const chunk = toInsert.slice(i, i + 500);
    const { data, error } = await db.from("bookings").insert(chunk).select("id");
    if (error) throw new Error(`insert chunk @${i} failed: ${JSON.stringify(error)}`);
    inserted += (data as unknown[])?.length ?? 0;
    process.stdout.write(`  …${Math.min(i + 500, toInsert.length)}/${toInsert.length}\r`);
  }
  console.log(`\n\nDONE. Inserted ${inserted} bookings.\n`);
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
