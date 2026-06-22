/**
 * Enrich client_profiles for Hi-Lite Studio customers with:
 *   - birthday / date_of_birth from Square
 *   - address → stored in notes (no address column in client_profiles)
 *
 * Only updates profiles that have a square_customer_id AND are linked to
 * hilite-studio via salon_clients. Never overwrites existing non-null values.
 *
 * Run:
 *   npx tsx scripts/enrich-hilite-studio-profiles.ts --dry-run
 *   npx tsx scripts/enrich-hilite-studio-profiles.ts
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const DRY_RUN = process.argv.includes("--dry-run");
const SQUARE_VERSION = "2024-12-18";
const SQUARE_API = "https://connect.squareup.com/v2";
const SALON_ID = "a7de260d-999e-4462-a11e-2297aa615012"; // hilite-studio

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

type SqCustomerFull = {
  id: string;
  birthday?: string; // "0000-MM-DD" or "YYYY-MM-DD"
  address?: {
    address_line_1?: string;
    address_line_2?: string;
    locality?: string;          // city
    administrative_district_level_1?: string; // state
    postal_code?: string;
    country?: string;
  };
};

async function fetchCustomerBatch(token: string, ids: string[]): Promise<SqCustomerFull[]> {
  // Square bulk-retrieve customers: POST /v2/customers/bulk-retrieve
  const res = await fetch(`${SQUARE_API}/customers/bulk-retrieve`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ customer_ids: ids }),
  });
  if (!res.ok) throw new Error(`Square bulk-retrieve HTTP ${res.status}`);
  const j = await res.json() as { responses?: Record<string, { customer?: SqCustomerFull; errors?: unknown[] }> };
  const out: SqCustomerFull[] = [];
  for (const [, v] of Object.entries(j.responses ?? {})) {
    if (v.customer) out.push(v.customer);
  }
  return out;
}

function parseSquareBirthday(raw: string | undefined): {
  birthday: string | null;      // "1900-MM-DD" (year=1900 sentinel when unknown)
  date_of_birth: string | null; // "YYYY-MM-DD" only when real year known
} {
  if (!raw) return { birthday: null, date_of_birth: null };
  // Square format: "0000-MM-DD" (month/day only) or "YYYY-MM-DD" (full DOB)
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { birthday: null, date_of_birth: null };
  const [, year, month, day] = m;
  if (year === "0000") {
    // Year unknown — store month/day with sentinel year 1900
    return { birthday: `1900-${month}-${day}`, date_of_birth: null };
  }
  return { birthday: `1900-${month}-${day}`, date_of_birth: `${year}-${month}-${day}` };
}

function formatAddress(a: SqCustomerFull["address"]): string | null {
  if (!a) return null;
  const parts = [
    a.address_line_1,
    a.address_line_2,
    [a.locality, a.administrative_district_level_1].filter(Boolean).join(", "),
    a.postal_code,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

async function main() {
  console.log(`\n=== Enrich hilite-studio profiles: birthday + address (${DRY_RUN ? "DRY RUN" : "WRITE"}) ===\n`);

  // Get Square token
  const { data: sqCfg } = await db
    .from("square_integrations")
    .select("access_token")
    .eq("salon_id", SALON_ID)
    .maybeSingle();
  if (!sqCfg) throw new Error("No square_integrations for hilite-studio");
  const token = (sqCfg as { access_token: string }).access_token;

  // Load all client_profiles for hilite-studio that have a square_customer_id
  console.log("Loading client profiles for hilite-studio...");
  type ProfileRow = { id: string; square_customer_id: string; birthday: string | null; date_of_birth: string | null; notes: string | null };
  const profiles: ProfileRow[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await db
      .from("salon_clients")
      .select("client_profiles!inner(id, square_customer_id, birthday, date_of_birth, notes)")
      .eq("salon_id", SALON_ID)
      .not("client_profiles.square_customer_id", "is", null)
      .range(from, from + 499);
    if (error) throw new Error(`Load profiles: ${error.message}`);
    const rows = (data ?? []) as unknown as { client_profiles: ProfileRow }[];
    profiles.push(...rows.map((r) => r.client_profiles));
    if (rows.length < 500) break;
  }
  console.log(`  ${profiles.length} profiles with Square customer ID`);

  const sqIds = profiles.map((p) => p.square_customer_id);
  console.log(`\nFetching full customer details from Square (${sqIds.length} customers)...`);

  // Build map: squareId → profile
  const profileBySqId = new Map<string, ProfileRow>();
  for (const p of profiles) profileBySqId.set(p.square_customer_id, p);

  // Batch fetch from Square (100 per call is max for bulk-retrieve)
  const BATCH = 100;
  const enriched: Array<{
    id: string;
    birthday?: string;
    date_of_birth?: string;
    notes?: string;
  }> = [];

  let withBirthday = 0;
  let withAddress = 0;
  let processed = 0;

  for (let i = 0; i < sqIds.length; i += BATCH) {
    const batch = sqIds.slice(i, i + BATCH);
    let customers: SqCustomerFull[];
    try {
      customers = await fetchCustomerBatch(token, batch);
    } catch (e) {
      console.warn(`  batch ${Math.floor(i / BATCH) + 1} error: ${e} — skipping`);
      continue;
    }

    for (const c of customers) {
      const profile = profileBySqId.get(c.id);
      if (!profile) continue;

      const { birthday, date_of_birth } = parseSquareBirthday(c.birthday);
      const addrStr = formatAddress(c.address);

      const update: { id: string; birthday?: string; date_of_birth?: string; notes?: string } = { id: profile.id };
      let changed = false;

      // Only fill in missing birthday (never overwrite)
      if (birthday && !profile.birthday) {
        update.birthday = birthday;
        changed = true;
        withBirthday++;
      }
      if (date_of_birth && !profile.date_of_birth) {
        update.date_of_birth = date_of_birth;
        changed = true;
      }

      // Address → notes, only if notes is currently empty
      if (addrStr && !profile.notes) {
        update.notes = `Địa chỉ: ${addrStr}`;
        changed = true;
        withAddress++;
      }

      if (changed) enriched.push(update);
    }

    processed += batch.length;
    process.stdout.write(`  ${processed}/${sqIds.length} fetched, ${enriched.length} to update...\r`);
  }

  console.log(`\n\nResults:`);
  console.log(`  With birthday data:  ${withBirthday}`);
  console.log(`  With address data:   ${withAddress}`);
  console.log(`  Total to update:     ${enriched.length}`);

  if (DRY_RUN) {
    console.log(`\nSample (first 10):`);
    for (const u of enriched.slice(0, 10)) {
      const p = profiles.find((x) => x.id === u.id);
      console.log(`  ${p?.square_customer_id} | ${p?.id.slice(0, 8)} | bday=${u.birthday ?? "-"} | dob=${u.date_of_birth ?? "-"} | addr=${u.notes ?? "-"}`);
    }
    console.log(`\n⚠️  DRY RUN — no writes. Re-run without --dry-run to update ${enriched.length} profiles.`);
    return;
  }

  if (enriched.length === 0) {
    console.log("\n✅ Nothing to update — all profiles already have complete data.");
    return;
  }

  console.log(`\nUpdating ${enriched.length} profiles...`);
  let updated = 0;
  for (const u of enriched) {
    const { id, ...fields } = u;
    const { error } = await db.from("client_profiles").update(fields).eq("id", id);
    if (error) throw new Error(`Update profile ${id}: ${error.message}`);
    updated++;
    if (updated % 25 === 0) process.stdout.write(`  ${updated}/${enriched.length} updated...\r`);
  }

  console.log(`\n\n✅ Done!`);
  console.log(`  Profiles enriched:   ${updated}`);
  console.log(`  With birthday:       ${withBirthday}`);
  console.log(`  With address→notes:  ${withAddress}`);
}

main().catch((e) => { console.error("\nFAILED:", e); process.exit(1); });
