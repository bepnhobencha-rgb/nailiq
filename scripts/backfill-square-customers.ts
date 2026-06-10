/**
 * Square customers -> NailIQ client_profiles backfill (Hi-Lite Anaheim).
 *
 * Pulls every Square customer for the merchant, canonicalizes the phone with
 * the SAME normalizer the app uses, dedups by canonical phone, and inserts the
 * NEW ones into the global `client_profiles` table. Existing NailIQ rows are
 * left untouched (insert ... on conflict do nothing) so we never clobber
 * owner-authored notes / visit history.
 *
 * Idempotent: re-running only inserts phones not already present; each inserted
 * row carries `square_customer_id` for future linkage.
 *
 *   npx tsx scripts/backfill-square-customers.ts --dry-run   # preview only
 *   npx tsx scripts/backfill-square-customers.ts             # write
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { toCanonicalPhone } from "../src/shared/lib/toCanonicalPhone";
import { getSquareConfig, listAllCustomers, type SquareCustomer } from "../src/shared/integrations/square/client";

const SALON_SLUG = "hilite-anaheim";
const DRY_RUN = process.argv.includes("--dry-run");
const ROOT = resolve(__dirname, "..");

// ---------- env ----------
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

// ---------- helpers ----------
const JUNK = new Set(["", ".", "..", "-", "n/a", "na", "none", "null"]);
function cleanName(c: SquareCustomer): string {
  const given = (c.given_name ?? "").trim();
  const family = (c.family_name ?? "").trim();
  const parts = [given, family].filter((p) => p && !JUNK.has(p.toLowerCase()));
  // Satisfy client_profiles_name_safe_check: no [<>{}=&;], length 1..100.
  return parts
    .join(" ")
    .replace(/&/g, "and")
    .replace(/[<>{}=;]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}
function cleanEmail(c: SquareCustomer): string | null {
  const e = (c.email_address ?? "").trim().toLowerCase();
  return e && e.includes("@") ? e : null;
}

async function fetchExistingPhones(): Promise<Set<string>> {
  const phones = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("client_profiles")
      .select("phone")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`client_profiles read failed: ${JSON.stringify(error)}`);
    const rows = (data as { phone: string }[]) ?? [];
    for (const r of rows) if (r.phone) phones.add(r.phone);
    if (rows.length < PAGE) break;
  }
  return phones;
}

async function main() {
  console.log(`\n=== Square -> NailIQ customer backfill (${DRY_RUN ? "DRY RUN" : "WRITE"}) ===\n`);

  const { data: salon, error: sErr } = await db
    .from("salons")
    .select("id, slug, name")
    .eq("slug", SALON_SLUG)
    .maybeSingle();
  if (sErr || !salon) throw new Error(`Salon ${SALON_SLUG} not found: ${JSON.stringify(sErr)}`);

  const cfg = await getSquareConfig(db, (salon as { id: string }).id);
  console.log(`Salon: ${(salon as { name: string }).name} (${cfg.salonId})`);
  console.log(`Square merchant ${cfg.merchantId}, location ${cfg.locationId}`);

  console.log(`\nPulling Square customers…`);
  const raw = await listAllCustomers(cfg);
  console.log(`  fetched ${raw.length} customers`);

  // Canonicalize + dedup by phone, keeping the most complete record.
  const byPhone = new Map<string, { sq: SquareCustomer; phone: string; name: string; email: string | null }>();
  let noPhone = 0;
  for (const c of raw) {
    const phone = toCanonicalPhone(c.phone_number);
    if (!phone) {
      noPhone++;
      continue;
    }
    const name = cleanName(c);
    const email = cleanEmail(c);
    const prev = byPhone.get(phone);
    const score = (n: string, e: string | null) => (n ? 2 : 0) + (e ? 1 : 0);
    if (!prev || score(name, email) > score(prev.name, prev.email)) {
      byPhone.set(phone, { sq: c, phone, name, email });
    }
  }

  console.log(`\nExisting NailIQ phones (for skip)…`);
  const existing = await fetchExistingPhones();
  console.log(`  client_profiles currently holds ${existing.size} phones`);

  const candidates = [...byPhone.values()];
  const fresh = candidates.filter((x) => !existing.has(x.phone));
  const alreadyIn = candidates.length - fresh.length;

  console.log(`\n--- SUMMARY ---`);
  console.log(`  raw Square customers .............. ${raw.length}`);
  console.log(`  no valid phone (skipped) .......... ${noPhone}`);
  console.log(`  unique by canonical phone ......... ${candidates.length}`);
  console.log(`  already in NailIQ (skip) .......... ${alreadyIn}`);
  console.log(`  NEW to insert ..................... ${fresh.length}`);
  console.log(`    of which with a real name ....... ${fresh.filter((x) => x.name).length}`);
  console.log(`    of which with an email .......... ${fresh.filter((x) => x.email).length}`);

  console.log(`\n--- SAMPLE (first 10 to insert) ---`);
  for (const x of fresh.slice(0, 10)) {
    console.log(`  ${x.phone}  ${x.name || "(no name)"}${x.email ? "  <" + x.email + ">" : ""}`);
  }

  if (DRY_RUN) {
    console.log(`\nDRY RUN — no rows written. Re-run without --dry-run to insert ${fresh.length} customers.\n`);
    return;
  }

  console.log(`\nInserting ${fresh.length} new customers (chunks of 500, on-conflict-do-nothing)…`);
  const rows = fresh.map((x) => ({
    phone: x.phone,
    name: x.name || null,
    email: x.email,
    square_customer_id: x.sq.id,
  }));
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { data, error } = await db
      .from("client_profiles")
      .upsert(chunk, { onConflict: "phone", ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(`insert chunk @${i} failed: ${JSON.stringify(error)}`);
    inserted += (data as unknown[])?.length ?? 0;
    process.stdout.write(`  …${Math.min(i + 500, rows.length)}/${rows.length}\r`);
  }
  console.log(`\n\nDONE. Inserted ${inserted} new client_profiles rows.\n`);
}

main().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
