/**
 * Full Square → NailIQ sync for Hi-Lite Studio (Westminster).
 *
 * Steps:
 *   1. List all Square locations → find Westminster → store in square_integrations
 *   2. Pull all Square customers who have payments at Westminster location
 *   3. Upsert client_profiles (global, phone-deduped)
 *   4. Link salon_clients for hilite-studio (salon-scoped)
 *   5. Upsert square_visit_history (salon-scoped, full payment history)
 *   6. Aggregate → salon_client_spend (salon-scoped lifetime spend)
 *
 * Run:
 *   npx tsx scripts/sync-hilite-studio-from-square.ts --dry-run   # preview
 *   npx tsx scripts/sync-hilite-studio-from-square.ts             # write
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { toCanonicalPhone } from "../src/shared/lib/toCanonicalPhone";

const DRY_RUN = process.argv.includes("--dry-run");
const SQUARE_VERSION = "2024-12-18";
const SQUARE_API = "https://connect.squareup.com/v2";
const SALON_SLUG = "hilite-studio";
const SOURCE_SALON_SLUG = "hilite-anaheim"; // same Square account, shares the token

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// ─── Square helpers ───────────────────────────────────────────────────────────

async function sq<T>(path: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SQUARE_API}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Square ${path} → HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

type Location = { id: string; name: string; address?: { address_line_1?: string; locality?: string } };
type SqCustomer = { id: string; given_name?: string; family_name?: string; phone_number?: string; email_address?: string };
type SqPayment = { id: string; status?: string; customer_id?: string; created_at?: string; amount_money?: { amount?: number }; order_id?: string };

async function listLocations(token: string): Promise<Location[]> {
  const r = await sq<{ locations?: Location[] }>("/locations", token);
  return r.locations ?? [];
}

async function listAllCustomers(token: string): Promise<SqCustomer[]> {
  const all: SqCustomer[] = [];
  let cursor: string | undefined;
  let page = 0;
  do {
    const r = await sq<{ customers?: SqCustomer[]; cursor?: string }>(
      `/customers?limit=100${cursor ? "&cursor=" + cursor : ""}`,
      token,
    );
    all.push(...(r.customers ?? []));
    cursor = r.cursor;
    page++;
    if (page % 5 === 0) process.stdout.write(`  fetched ${all.length} customers...\r`);
  } while (cursor && page < 500);
  return all;
}

async function listPaymentsForLocation(token: string, locationId: string): Promise<SqPayment[]> {
  const all: SqPayment[] = [];
  let cursor: string | undefined;
  let page = 0;
  do {
    const params = new URLSearchParams({ location_id: locationId, limit: "100", sort_order: "ASC" });
    if (cursor) params.set("cursor", cursor);
    const r = await sq<{ payments?: SqPayment[]; cursor?: string }>(`/payments?${params}`, token);
    for (const p of r.payments ?? []) {
      if (p.status === "COMPLETED" && p.customer_id) all.push(p);
    }
    cursor = r.cursor;
    page++;
    if (page % 10 === 0) process.stdout.write(`  page ${page}, ${all.length} payments...\r`);
  } while (cursor && page < 500);
  return all;
}

async function fetchOrderServiceNames(token: string, orderIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (let i = 0; i < orderIds.length; i += 100) {
    const batch = orderIds.slice(i, i + 100);
    try {
      const r = await sq<{ orders?: Array<{ id?: string; line_items?: Array<{ name?: string }> }> }>(
        "/orders/batch-retrieve", token, { order_ids: batch },
      );
      for (const o of r.orders ?? []) {
        if (!o.id) continue;
        const names = (o.line_items ?? []).map((li) => (li.name ?? "").trim()).filter(Boolean);
        if (names.length) result.set(o.id, names);
      }
    } catch { /* best-effort */ }
    if (i % 1000 === 0 && i > 0) process.stdout.write(`  orders ${i}/${orderIds.length}...\r`);
  }
  return result;
}

// ─── Name / email helpers ─────────────────────────────────────────────────────

const JUNK = new Set(["", ".", "..", "-", "n/a", "na", "none", "null"]);
function cleanName(c: SqCustomer): string {
  const given = (c.given_name ?? "").trim();
  const family = (c.family_name ?? "").trim();
  return [given, family]
    .filter((p) => p && !JUNK.has(p.toLowerCase()))
    .join(" ")
    .replace(/&/g, "and")
    .replace(/[<>{}=;]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}
function cleanEmail(c: SqCustomer): string | null {
  const e = (c.email_address ?? "").trim().toLowerCase();
  return e && e.includes("@") ? e : null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Square → NailIQ sync: ${SALON_SLUG} (${DRY_RUN ? "DRY RUN" : "WRITE"}) ===\n`);

  // Load target salon
  const { data: salon } = await db.from("salons").select("id, name").eq("slug", SALON_SLUG).maybeSingle();
  if (!salon) throw new Error(`Salon '${SALON_SLUG}' not found`);
  const salonId = (salon as { id: string; name: string }).id;
  console.log(`Target salon: ${(salon as { id: string; name: string }).name} (${salonId})`);

  // Load Square token from source salon (same account)
  const { data: srcSalon } = await db.from("salons").select("id").eq("slug", SOURCE_SALON_SLUG).maybeSingle();
  if (!srcSalon) throw new Error(`Source salon '${SOURCE_SALON_SLUG}' not found`);
  const { data: srcCfg } = await db
    .from("square_integrations")
    .select("access_token, merchant_id, environment")
    .eq("salon_id", (srcSalon as { id: string }).id)
    .maybeSingle();
  if (!srcCfg) throw new Error("No Square integration found on hilite-anaheim");
  const { access_token: token, merchant_id: merchantId, environment } = srcCfg as {
    access_token: string; merchant_id: string; environment: string;
  };
  console.log(`Square merchant: ${merchantId} (${environment})`);

  // ── STEP 1: Find Westminster location ───────────────────────────────────────
  console.log("\n[1/6] Listing Square locations...");
  const locations = await listLocations(token);
  console.log(`  Found ${locations.length} location(s):`);
  for (const loc of locations) {
    const addr = [loc.address?.address_line_1, loc.address?.locality].filter(Boolean).join(", ");
    console.log(`    ${loc.id}  ${loc.name}  ${addr}`);
  }

  // Find Westminster (exclude Anaheim which is LKNG1X7QRRQ4M)
  const westminster = locations.find(
    (l) =>
      l.id !== "LKNG1X7QRRQ4M" &&
      (
        (l.address?.locality ?? "").toLowerCase().includes("westminster") ||
        (l.name ?? "").toLowerCase().includes("westminster") ||
        (l.name ?? "").toLowerCase().includes("studio")
      ),
  );
  if (!westminster) {
    console.log("\n⚠️  Could not auto-detect Westminster location. Available locations printed above.");
    console.log("  Edit this script and set WESTMINSTER_LOCATION_ID manually, then re-run.");
    process.exit(1);
  }
  const westminsterLocationId = westminster.id;
  console.log(`\n  ✅ Westminster location: ${westminsterLocationId} — "${westminster.name}"`);

  // ── STEP 2: Upsert square_integrations for hilite-studio ───────────────────
  console.log("\n[2/6] Creating square_integrations for hilite-studio...");
  if (!DRY_RUN) {
    const { error } = await db.from("square_integrations").upsert({
      salon_id: salonId,
      merchant_id: merchantId,
      location_id: westminsterLocationId,
      access_token: token,
      environment: environment as "production" | "sandbox",
      enabled: true,
      sync_pull_create: true,
      sync_pull_update: true,
      sync_pull_cancel: true,
      sync_push_create: false,
      sync_push_update: false,
      sync_push_cancel: false,
    }, { onConflict: "salon_id" });
    if (error) throw new Error(`square_integrations upsert: ${error.message}`);
    console.log(`  ✅ square_integrations row saved (location: ${westminsterLocationId})`);
  } else {
    console.log(`  [dry] Would save integration row with location_id=${westminsterLocationId}`);
  }

  // ── STEP 3: Pull payments for Westminster location ──────────────────────────
  console.log("\n[3/6] Fetching completed payments at Westminster location...");
  const payments = await listPaymentsForLocation(token, westminsterLocationId);
  console.log(`\n  Total completed payments with customer: ${payments.length}`);

  const westCustomerIds = new Set(payments.map((p) => p.customer_id!));
  console.log(`  Unique Square customers who paid at Westminster: ${westCustomerIds.size}`);

  if (payments.length === 0) {
    console.log("\n⚠️  No payments found. Check the location ID is correct.");
    process.exit(0);
  }

  // ── STEP 4: Pull Square customers and build profiles ───────────────────────
  console.log("\n[4/6] Pulling Square customer records...");
  const allSqCustomers = await listAllCustomers(token);
  console.log(`\n  Total merchant customers: ${allSqCustomers.length}`);

  // Keep only customers who have payments at Westminster
  const westCustomers = allSqCustomers.filter((c) => westCustomerIds.has(c.id));
  console.log(`  Customers with Westminster payments: ${westCustomers.length}`);

  // Dedup by canonical phone
  const byPhone = new Map<string, { sq: SqCustomer; phone: string; name: string; email: string | null }>();
  let noPhone = 0;
  for (const c of westCustomers) {
    const phone = toCanonicalPhone(c.phone_number);
    if (!phone) { noPhone++; continue; }
    const name = cleanName(c);
    const email = cleanEmail(c);
    const prev = byPhone.get(phone);
    const score = (n: string, e: string | null) => (n ? 2 : 0) + (e ? 1 : 0);
    if (!prev || score(name, email) > score(prev.name, prev.email)) {
      byPhone.set(phone, { sq: c, phone, name, email });
    }
  }
  console.log(`  No valid phone (skipped): ${noPhone}`);
  console.log(`  Unique by phone: ${byPhone.size}`);

  // Fetch existing phones in client_profiles (global)
  const existingPhones = new Set<string>();
  const existingBySqId = new Map<string, string>(); // squareId → profileId
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from("client_profiles").select("id, phone, square_customer_id").range(from, from + 999);
    const rows = (data ?? []) as { id: string; phone: string; square_customer_id: string | null }[];
    for (const r of rows) {
      if (r.phone) existingPhones.add(r.phone);
      if (r.square_customer_id) existingBySqId.set(r.square_customer_id, r.id);
    }
    if (rows.length < 1000) break;
  }

  const candidates = [...byPhone.values()];
  const fresh = candidates.filter((x) => !existingPhones.has(x.phone));
  console.log(`\n  Already in NailIQ: ${candidates.length - fresh.length}`);
  console.log(`  NEW profiles to insert: ${fresh.length}`);

  if (!DRY_RUN && fresh.length > 0) {
    console.log(`  Inserting ${fresh.length} new client_profiles...`);
    const rows = fresh.map((x) => ({
      phone: x.phone,
      name: x.name || null,
      email: x.email,
      square_customer_id: x.sq.id,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await db.from("client_profiles").upsert(chunk, {
        onConflict: "phone",
        ignoreDuplicates: true,
      });
      if (error) throw new Error(`client_profiles insert: ${error.message}`);
      process.stdout.write(`  ${Math.min(i + 500, rows.length)}/${rows.length} inserted...\r`);
    }
    console.log(`\n  ✅ client_profiles done`);
  }

  // Re-fetch squareId → profileId mapping (now includes newly inserted)
  const sqIdToProfile = new Map<string, string>(existingBySqId);
  if (!DRY_RUN) {
    const squareIdsToLookup = westCustomers.map((c) => c.id).filter((id) => !sqIdToProfile.has(id));
    for (let i = 0; i < squareIdsToLookup.length; i += 300) {
      const chunk = squareIdsToLookup.slice(i, i + 300);
      const { data } = await db
        .from("client_profiles")
        .select("id, square_customer_id")
        .in("square_customer_id", chunk);
      for (const r of (data ?? []) as { id: string; square_customer_id: string }[]) {
        if (r.square_customer_id) sqIdToProfile.set(r.square_customer_id, r.id);
      }
    }
  }

  // ── STEP 5: salon_clients (link profile → hilite-studio) ───────────────────
  console.log("\n[5/6] Linking clients to hilite-studio salon...");
  const profileIdsToLink = [...new Set(
    westCustomers.map((c) => sqIdToProfile.get(c.id)).filter(Boolean) as string[]
  )];
  console.log(`  Profiles to link: ${profileIdsToLink.length}`);

  if (!DRY_RUN && profileIdsToLink.length > 0) {
    const rows = profileIdsToLink.map((pid) => ({
      salon_id: salonId,
      client_profile_id: pid,
      source: "square",
      external_ref: null,
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error } = await db.from("salon_clients").upsert(chunk as never, {
        onConflict: "salon_id,client_profile_id",
        ignoreDuplicates: true,
      });
      if (error) throw new Error(`salon_clients insert: ${error.message}`);
    }
    console.log(`  ✅ salon_clients: ${profileIdsToLink.length} links`);
  }

  // ── STEP 6: square_visit_history ────────────────────────────────────────────
  console.log("\n[6/6] Building visit history...");
  const orderIds = [...new Set(payments.filter((p) => p.order_id).map((p) => p.order_id!))];
  console.log(`  Fetching service names for ${orderIds.length} orders...`);
  const orderServiceMap = await fetchOrderServiceNames(token, orderIds);
  console.log(`  Got names for ${orderServiceMap.size} orders`);

  const now = new Date().toISOString();
  const visitRows = payments.map((p) => ({
    salon_id: salonId,
    client_profile_id: sqIdToProfile.get(p.customer_id!) ?? null,
    square_customer_id: p.customer_id!,
    square_payment_id: p.id,
    square_created_at: p.created_at!,
    visit_date: new Date(p.created_at!).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }),
    amount_cents: Number(p.amount_money?.amount ?? 0),
    order_id: p.order_id ?? null,
    service_names: p.order_id ? (orderServiceMap.get(p.order_id) ?? null) : null,
    synced_at: now,
  }));

  console.log(`  ${visitRows.length} visit rows to upsert`);
  if (!DRY_RUN) {
    let upserted = 0;
    for (let i = 0; i < visitRows.length; i += 500) {
      const chunk = visitRows.slice(i, i + 500);
      const { error } = await db
        .from("square_visit_history")
        .upsert(chunk as never, { onConflict: "salon_id,square_payment_id" });
      if (error) throw new Error(`square_visit_history upsert: ${error.message}`);
      upserted += chunk.length;
      process.stdout.write(`  ${upserted}/${visitRows.length} upserted...\r`);
    }
    console.log(`\n  ✅ square_visit_history: ${upserted} rows`);
  }

  // ── STEP 7: salon_client_spend ──────────────────────────────────────────────
  console.log("\n[7/7] Aggregating spend per client...");
  type SpendAgg = { total: number; count: number; lastAt: string | null };
  const byProfile = new Map<string, SpendAgg>();
  for (const p of payments) {
    const pid = sqIdToProfile.get(p.customer_id!);
    if (!pid) continue;
    const amt = Number(p.amount_money?.amount ?? 0);
    if (amt <= 0) continue;
    const cur = byProfile.get(pid) ?? { total: 0, count: 0, lastAt: null };
    cur.total += amt;
    cur.count += 1;
    if (p.created_at && (!cur.lastAt || p.created_at > cur.lastAt)) cur.lastAt = p.created_at;
    byProfile.set(pid, cur);
  }

  let totalDollars = 0;
  const spendRows = [...byProfile.entries()].map(([pid, a]) => {
    totalDollars += a.total;
    return {
      salon_id: salonId,
      client_profile_id: pid,
      total_spend_cents: a.total,
      payment_count: a.count,
      last_payment_at: a.lastAt,
      synced_at: now,
    };
  });

  console.log(`  Profiles with spend: ${spendRows.length}`);
  console.log(`  Total revenue: $${(totalDollars / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);

  if (!DRY_RUN && spendRows.length > 0) {
    for (let i = 0; i < spendRows.length; i += 500) {
      const chunk = spendRows.slice(i, i + 500);
      const { error } = await db
        .from("salon_client_spend")
        .upsert(chunk as never, { onConflict: "salon_id,client_profile_id" });
      if (error) throw new Error(`salon_client_spend upsert: ${error.message}`);
    }
    console.log(`  ✅ salon_client_spend: ${spendRows.length} rows`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(60)}`);
  console.log(`✅ Sync ${DRY_RUN ? "preview" : "complete"} for ${SALON_SLUG}`);
  console.log(`  Square location:   ${westminsterLocationId}`);
  console.log(`  Payments synced:   ${payments.length}`);
  console.log(`  Unique customers:  ${westCustomerIds.size}`);
  console.log(`  New profiles:      ${fresh.length}`);
  console.log(`  Profiles linked:   ${profileIdsToLink.length}`);
  console.log(`  Visit rows:        ${visitRows.length}`);
  console.log(`  Spend rows:        ${spendRows.length}`);
  console.log(`  Total revenue:     $${(totalDollars / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
  if (DRY_RUN) console.log(`\n⚠️  DRY RUN — no data was written. Re-run without --dry-run to sync.`);
  console.log();
}

main().catch((e) => { console.error("\nFAILED:", e); process.exit(1); });
