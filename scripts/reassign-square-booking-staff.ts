/**
 * Make imported Square bookings VISIBLE on the NailIQ receptionist calendar.
 *
 * The calendar drops bookings with staff_id = null (loadReceptionistCenterData
 * ~line 968). The Square import left staff_id null, so it was invisible. This
 * assigns each render-status Square booking to one of the 7 existing active
 * staff columns. Staff rows are NOT renamed/modified (owner kept Anna..Ivy).
 *
 * Distribution: a booking goes to the staff column standing in for its real
 * Square bed first; if that column is busy at that time, any other free column.
 * So group bookings (different Square beds, same time) keep separate columns and
 * nothing overlaps -> no bookings_no_overlap GIST violation. Bookings that can't
 * fit (>7 concurrent, mostly phantom Square beds) stay null and are reported.
 *
 *   npx tsx scripts/reassign-square-booking-staff.ts --dry-run
 *   npx tsx scripts/reassign-square-booking-staff.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { getSquareConfig, listBookings } from "../src/shared/integrations/square/client";

const DRY_RUN = process.argv.includes("--dry-run");
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
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Square "BED N" team_member_id -> bed slot 0..6 (used only to spread evenly).
const BED_SLOT: Record<string, number> = {
  "TM-0aDzkyVci0JTg": 0, "TMcWHjF7NpLhHh-d": 1, "TMXX9-y8DOK83YJq": 2,
  "TMoZv513uQiPBVPv": 3, "TMlnUF2RhpwtXaqz": 4, "TMxqQZuPIt8FlYhS": 5, "TMZVLspwc2GkpH09": 6,
};
const RENDER_STATUS = new Set(["pending", "confirmed", "in_progress", "completed"]);
const overlaps = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;

async function main() {
  console.log(`\n=== Assign Square bookings to staff columns (${DRY_RUN ? "DRY RUN" : "WRITE"}) ===\n`);
  const { data: salon } = await db.from("salons").select("id").eq("slug", "hilite-anaheim").maybeSingle();
  const salonId = (salon as { id: string }).id;
  const cfg = await getSquareConfig(db, salonId);

  // 7 active staff (names untouched). Index = bed slot.
  const { data: staffRows } = await db
    .from("staff").select("id, name").eq("salon_id", salonId).eq("status", "active").is("deleted_at", null).order("name");
  const staff = (staffRows as { id: string; name: string }[]) ?? [];
  if (staff.length < 7) throw new Error(`Expected >=7 active staff, found ${staff.length}`);
  const slotStaffId = staff.slice(0, 7).map((s) => s.id);
  const slotName = staff.slice(0, 7).map((s) => s.name);
  console.log(`Columns: ${slotName.join(", ")}`);

  // Square booking -> team_member_id -> preferred slot.
  const now = new Date();
  const sqBookings = await listBookings(cfg, new Date(now.getFullYear(), now.getMonth() - 12, now.getDate()), new Date(now.getTime() + 60 * 86_400_000));
  const slotByBooking = new Map<string, number | undefined>();
  for (const b of sqBookings) slotByBooking.set(b.id, BED_SLOT[b.appointment_segments?.[0]?.team_member_id ?? ""]);

  // Seed each column's occupancy with existing non-Square bookings on that staff.
  const occ = new Map<string, [number, number][]>();
  for (const id of slotStaffId) occ.set(id, []);
  const { data: existing } = await db
    .from("bookings").select("staff_id, start_time_utc, end_time_utc, status")
    .eq("salon_id", salonId).is("square_booking_id", null).not("staff_id", "is", null);
  for (const r of (existing as { staff_id: string; start_time_utc: string; end_time_utc: string; status: string }[]) ?? [])
    if (RENDER_STATUS.has(r.status) && occ.has(r.staff_id)) occ.get(r.staff_id)!.push([Date.parse(r.start_time_utc), Date.parse(r.end_time_utc)]);

  // Imported Square bookings needing a column, earliest first.
  const { data: imp } = await db
    .from("bookings").select("id, square_booking_id, start_time_utc, end_time_utc, status")
    .eq("salon_id", salonId).not("square_booking_id", "is", null).in("status", [...RENDER_STATUS]).order("start_time_utc");
  const rows = (imp as { id: string; square_booking_id: string; start_time_utc: string; end_time_utc: string; status: string }[]) ?? [];

  const assigns: { id: string; staff_id: string }[] = [];
  let overflow = 0, faithful = 0, fallback = 0;
  for (const r of rows) {
    const s = Date.parse(r.start_time_utc), e = Date.parse(r.end_time_utc);
    const pref = slotByBooking.get(r.square_booking_id);
    const order = [...Array(7).keys()].sort((a, b) => (a === pref ? -1 : b === pref ? 1 : 0));
    let placed: string | null = null, placedSlot = -1;
    for (const slot of order) {
      const id = slotStaffId[slot], iv = occ.get(id)!;
      if (!iv.some(([os, oe]) => overlaps(s, e, os, oe))) { placed = id; placedSlot = slot; iv.push([s, e]); break; }
    }
    if (!placed) { overflow++; continue; }
    if (placedSlot === pref) faithful++; else fallback++;
    assigns.push({ id: r.id, staff_id: placed });
  }

  console.log(`\n--- SUMMARY ---`);
  console.log(`  render-status Square bookings ......... ${rows.length}`);
  console.log(`  placed on their real bed's column ..... ${faithful}`);
  console.log(`  placed on a fallback free column ...... ${fallback}`);
  console.log(`  overflow (stay hidden, >7 concurrent) . ${overflow}`);
  console.log(`  of placed, upcoming ................... ${assigns.filter((a) => Date.parse(rows.find((r) => r.id === a.id)!.start_time_utc) >= now.getTime()).length}`);

  if (DRY_RUN) { console.log(`\nDRY RUN — no writes.\n`); return; }

  console.log(`\nAssigning ${assigns.length} bookings…`);
  let done = 0;
  for (const a of assigns) {
    const { error } = await db.from("bookings").update({ staff_id: a.staff_id }).eq("id", a.id);
    if (error) throw new Error(`assign ${a.id}: ${JSON.stringify(error)}`);
    if (++done % 100 === 0) process.stdout.write(`  …${done}/${assigns.length}\r`);
  }
  console.log(`\n\nDONE. ${assigns.length} bookings now visible (${overflow} overflow unassigned).\n`);
}
main().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
