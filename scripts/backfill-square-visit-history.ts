/**
 * One-time backfill: pull all Square payments for Hi-Lite Anaheim into
 * square_visit_history. Run with:
 *   npx tsx scripts/backfill-square-visit-history.ts
 *
 * Expects env: SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL, ANTHROPIC_API_KEY (optional).
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const SQUARE_VERSION = "2024-10-17";
const SQUARE_API = "https://connect.squareup.com/v2";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function getSquareConfig(salonId: string) {
  const { data, error } = await supabase
    .from("square_integrations")
    .select("location_id, access_token, environment")
    .eq("salon_id", salonId)
    .maybeSingle();
  if (error || !data) throw new Error(`Square config not found: ${error?.message}`);
  return data as { location_id: string; access_token: string; environment: string };
}

async function fetchOrderServiceNames(
  token: string,
  orderIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (orderIds.length === 0) return result;
  for (let i = 0; i < orderIds.length; i += 100) {
    const batch = orderIds.slice(i, i + 100);
    try {
      const res = await fetch(`${SQUARE_API}/orders/batch-retrieve`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Square-Version": SQUARE_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ order_ids: batch }),
      });
      if (!res.ok) {
        console.warn(`  orders batch HTTP ${res.status} (skipping batch ${i / 100 + 1})`);
        continue;
      }
      const j = await res.json() as { orders?: Array<{ id?: string; line_items?: Array<{ name?: string }> }> };
      for (const order of j.orders ?? []) {
        if (!order.id) continue;
        const names = (order.line_items ?? []).map((li) => (li.name ?? "").trim()).filter(Boolean);
        if (names.length > 0) result.set(order.id, names);
      }
    } catch (e) {
      console.warn(`  orders batch error (skipping): ${e}`);
    }
  }
  return result;
}

async function main() {
  // Find Hi-Lite Anaheim salon
  const { data: salon } = await supabase
    .from("salons")
    .select("id, name")
    .eq("slug", "hilite-anaheim")
    .maybeSingle();
  if (!salon) throw new Error("hilite-anaheim salon not found");
  const salonId = (salon as { id: string; name: string }).id;
  console.log(`Salon: ${(salon as { id: string; name: string }).name} (${salonId})`);

  const cfg = await getSquareConfig(salonId);
  console.log(`Square env: ${cfg.environment}, location: ${cfg.location_id}`);

  // Page through ALL completed Square payments
  console.log("\nFetching Square payments...");
  type PaymentRaw = { id: string; customer_id: string; created_at: string; amount_money?: { amount?: number }; order_id?: string };
  const payments: PaymentRaw[] = [];
  let cursor: string | undefined;
  let page = 0;
  do {
    const params = new URLSearchParams({
      location_id: cfg.location_id,
      limit: "100",
      sort_order: "ASC",
    });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${SQUARE_API}/payments?${params.toString()}`, {
      headers: { Authorization: `Bearer ${cfg.access_token}`, "Square-Version": SQUARE_VERSION },
    });
    if (!res.ok) throw new Error(`Square payments HTTP ${res.status}`);
    const j = await res.json() as { payments?: PaymentRaw[]; cursor?: string };
    for (const p of j.payments ?? []) {
      if ((p as { status?: string }).status === "COMPLETED" && p.customer_id && p.id && p.created_at) {
        payments.push(p);
      }
    }
    cursor = j.cursor;
    page++;
    if (page % 10 === 0) process.stdout.write(`  page ${page}, ${payments.length} payments so far...\r`);
  } while (cursor && page < 300);
  console.log(`\nTotal completed payments with customer: ${payments.length}`);

  // Map Square customer_id → client_profile_id
  console.log("\nMapping Square customers → NailIQ profiles...");
  const squareIds = [...new Set(payments.map((p) => p.customer_id))];
  const idToProfile = new Map<string, string>();
  for (let i = 0; i < squareIds.length; i += 300) {
    const chunk = squareIds.slice(i, i + 300);
    const { data } = await supabase
      .from("client_profiles")
      .select("id, square_customer_id")
      .in("square_customer_id", chunk);
    for (const r of (data ?? []) as { id: string; square_customer_id: string }[]) {
      if (r.square_customer_id) idToProfile.set(r.square_customer_id, r.id);
    }
  }
  console.log(`Matched ${idToProfile.size} / ${squareIds.length} Square customers to NailIQ profiles`);

  // Fetch service names from Square Orders
  console.log("\nFetching order line items for service names...");
  const orderIds = [...new Set(payments.filter((p) => p.order_id).map((p) => p.order_id!))];
  console.log(`  ${orderIds.length} unique orders to fetch`);
  const orderServiceMap = await fetchOrderServiceNames(cfg.access_token, orderIds);
  console.log(`  Got service names for ${orderServiceMap.size} orders`);

  // Build rows
  const now = new Date().toISOString();
  const rows = payments.map((p) => ({
    salon_id: salonId,
    client_profile_id: idToProfile.get(p.customer_id) ?? null,
    square_customer_id: p.customer_id,
    square_payment_id: p.id,
    square_created_at: p.created_at,
    visit_date: new Date(p.created_at)
      .toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }),
    amount_cents: Number(p.amount_money?.amount ?? 0),
    order_id: p.order_id ?? null,
    service_names: p.order_id ? (orderServiceMap.get(p.order_id) ?? null) : null,
    synced_at: now,
  }));

  // Upsert in batches of 500
  console.log("\nUpserting to square_visit_history...");
  let upserted = 0;
  let withServices = 0;
  let withProfile = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase
      .from("square_visit_history")
      .upsert(chunk as never, { onConflict: "salon_id,square_payment_id" });
    if (error) {
      console.error(`  batch ${i / 500 + 1} error:`, error.message);
    } else {
      upserted += chunk.length;
      withServices += chunk.filter((r) => r.service_names && r.service_names.length > 0).length;
      withProfile += chunk.filter((r) => r.client_profile_id).length;
    }
    process.stdout.write(`  ${upserted}/${rows.length} upserted...\r`);
  }

  console.log(`\n\n✅ Done!`);
  console.log(`  Total upserted:   ${upserted}`);
  console.log(`  With NailIQ profile: ${withProfile} (${Math.round(withProfile / upserted * 100)}%)`);
  console.log(`  With service names:  ${withServices} (${Math.round(withServices / upserted * 100)}%)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
