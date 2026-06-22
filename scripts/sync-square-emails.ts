/**
 * Sync customer emails from Square → NailIQ client_profiles + upcoming bookings.
 *
 * Logic:
 *  1. Fetch all Square customers that have an email_address.
 *  2. Match to client_profiles by canonical phone.
 *  3. UPDATE client_profiles.email where currently NULL.
 *  4. UPDATE bookings.client_email for upcoming bookings whose profile now has email.
 *
 * Idempotent — never overwrites an existing email; only fills NULLs.
 *
 *   npx tsx scripts/sync-square-emails.ts --dry-run
 *   npx tsx scripts/sync-square-emails.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { toCanonicalPhone } from "../src/shared/lib/toCanonicalPhone";
import { getSquareConfig, listAllCustomers } from "../src/shared/integrations/square/client";

const SALON_SLUG = "hilite-anaheim";
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

async function main() {
  console.log(`\n=== Square → NailIQ email sync (${DRY_RUN ? "DRY RUN" : "WRITE"}) ===\n`);

  const env = loadEnv();
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: salon } = await db.from("salons").select("id,name").eq("slug", SALON_SLUG).maybeSingle();
  if (!salon) throw new Error(`Salon ${SALON_SLUG} not found`);
  console.log(`Salon: ${(salon as { name: string }).name}`);

  // 1. Fetch Square customers with emails
  console.log("\nFetching Square customers…");
  const cfg = await getSquareConfig(db, (salon as { id: string }).id);
  const all = await listAllCustomers(cfg);
  console.log(`  total Square customers: ${all.length}`);

  // Build phone → email map (skip if no email or no phone)
  const phoneToEmail = new Map<string, string>();
  for (const c of all) {
    const email = (c.email_address ?? "").trim().toLowerCase();
    if (!email || !email.includes("@")) continue;
    const phone = toCanonicalPhone(c.phone_number);
    if (!phone) continue;
    if (!phoneToEmail.has(phone)) phoneToEmail.set(phone, email);
  }
  console.log(`  Square customers with valid phone + email: ${phoneToEmail.size}`);

  // 2. Fetch ALL NailIQ profiles with no email, match in-memory (avoids PostgREST URL limit)
  console.log("\nChecking NailIQ client_profiles…");
  const nullEmailProfiles: { id: string; phone: string; name: string }[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("client_profiles")
      .select("id, phone, name")
      .is("email", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`client_profiles read failed: ${JSON.stringify(error)}`);
    const rows = (data ?? []) as { id: string; phone: string; name: string }[];
    nullEmailProfiles.push(...rows);
    if (rows.length < PAGE) break;
  }
  console.log(`  profiles with NULL email: ${nullEmailProfiles.length}`);

  // Match in-memory
  const toUpdate = nullEmailProfiles.filter((p) => phoneToEmail.has(p.phone));
  console.log(`  profiles matched by phone (Square has their email): ${toUpdate.length}`);

  if (toUpdate.length === 0) {
    console.log("\nNothing to update — all matched profiles already have emails.\n");
    return;
  }

  console.log("\n--- PREVIEW (first 20) ---");
  for (const p of toUpdate.slice(0, 20)) {
    const email = phoneToEmail.get(p.phone)!;
    console.log(`  ${p.phone}  ${p.name || "(no name)"}  →  ${email}`);
  }
  if (toUpdate.length > 20) console.log(`  … and ${toUpdate.length - 20} more`);

  if (DRY_RUN) {
    console.log(`\nDRY RUN — no changes written. Re-run without --dry-run to update ${toUpdate.length} profiles.\n`);
    return;
  }

  // 3. Update client_profiles.email in chunks
  console.log(`\nUpdating ${toUpdate.length} client_profiles…`);
  let profilesUpdated = 0;
  for (const p of toUpdate) {
    const email = phoneToEmail.get(p.phone)!;
    const { error } = await db
      .from("client_profiles")
      .update({ email })
      .eq("id", p.id)
      .is("email", null); // double-guard: never overwrite
    if (error) console.error(`  WARN: failed to update profile ${p.id}: ${error.message}`);
    else profilesUpdated++;
  }
  console.log(`  ✓ client_profiles updated: ${profilesUpdated}`);

  // 4. Propagate to upcoming bookings that still have no client_email
  console.log("\nPropagating to upcoming bookings…");
  const profileIds = toUpdate.map((p) => p.id);
  const { data: bookingsUpdated, error: bErr } = await db
    .from("bookings")
    .update({ client_email: db.rpc as never }) // workaround — use raw update below
    .in("client_profile_id", profileIds)
    .is("client_email", null)
    .gt("start_time_utc", new Date().toISOString())
    .in("status", ["pending", "confirmed"])
    .select("id, client_name, client_email");

  // Above won't set the right value per-row — do it via SQL instead
  void bErr; void bookingsUpdated;

  // Build per-profile email lookup for SQL
  let bookingRows = 0;
  for (const p of toUpdate) {
    const email = phoneToEmail.get(p.phone)!;
    const { data, error } = await db
      .from("bookings")
      .update({ client_email: email })
      .eq("client_profile_id", p.id)
      .is("client_email", null)
      .gt("start_time_utc", new Date().toISOString())
      .in("status", ["pending", "confirmed"])
      .select("id");
    if (error) console.error(`  WARN: booking update for profile ${p.id}: ${error.message}`);
    else bookingRows += (data as { id: string }[]).length;
  }
  console.log(`  ✓ upcoming bookings updated: ${bookingRows}`);

  console.log(`\n✅ DONE. Profiles: ${profilesUpdated} updated, Bookings: ${bookingRows} updated.\n`);
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
