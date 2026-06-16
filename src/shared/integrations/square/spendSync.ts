import "server-only";
import { looseServiceClient } from "./looseDb";
import { getSquareConfig, type SquareConfig } from "./client";

const SQUARE_VERSION = "2024-10-17";

function apiBase(env: string): string {
  return env === "sandbox"
    ? "https://connect.squareupsandbox.com/v2"
    : "https://connect.squareup.com/v2";
}

type SquarePayment = {
  status?: string;
  customer_id?: string;
  created_at?: string;
  amount_money?: { amount?: number };
};

type Agg = { total: number; count: number; lastAt: string | null };

/**
 * Page through ALL completed Square payments for the salon's location and
 * aggregate total amount + count + last-paid per Square customer_id. Money truth
 * lives in Square; NailIQ only had bookings, not amounts paid.
 */
async function aggregatePaymentsByCustomer(
  cfg: SquareConfig,
): Promise<Map<string, Agg>> {
  const agg = new Map<string, Agg>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const params = new URLSearchParams({
      location_id: cfg.locationId,
      limit: "100",
      sort_order: "ASC",
    });
    if (cursor) params.set("cursor", cursor);
    const res = await fetch(`${apiBase(cfg.environment)}/payments?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
        "Square-Version": SQUARE_VERSION,
      },
    });
    if (!res.ok) throw new Error(`Square payments HTTP ${res.status}`);
    const j = (await res.json()) as {
      payments?: SquarePayment[];
      cursor?: string;
      errors?: unknown;
    };
    if (j.errors) throw new Error(`Square payments error: ${JSON.stringify(j.errors)}`);
    for (const p of j.payments ?? []) {
      if (p.status !== "COMPLETED") continue;
      const cid = p.customer_id;
      if (!cid) continue;
      const amt = Number(p.amount_money?.amount ?? 0);
      if (amt <= 0) continue;
      const cur = agg.get(cid) ?? { total: 0, count: 0, lastAt: null };
      cur.total += amt;
      cur.count += 1;
      if (p.created_at && (!cur.lastAt || p.created_at > cur.lastAt)) cur.lastAt = p.created_at;
      agg.set(cid, cur);
    }
    cursor = j.cursor;
    pages += 1;
  } while (cursor && pages < 300); // safety cap (300 × 100 = 30k payments)
  return agg;
}

/**
 * Sync each customer's lifetime spend AT THIS SALON from Square into
 * `salon_client_spend`. Only customers linked to a NailIQ identity
 * (client_profiles.square_customer_id) get a row. Salon-scoped. Service-role.
 */
export async function syncSquareSpend(salonId: string): Promise<{
  ok: boolean;
  squareCustomers: number;
  matchedProfiles: number;
  totalCents: number;
  error?: string;
}> {
  const db = looseServiceClient();

  let cfg: SquareConfig;
  try {
    cfg = await getSquareConfig(db, salonId);
  } catch (e) {
    return { ok: false, squareCustomers: 0, matchedProfiles: 0, totalCents: 0, error: String(e) };
  }

  let agg: Map<string, Agg>;
  try {
    agg = await aggregatePaymentsByCustomer(cfg);
  } catch (e) {
    return { ok: false, squareCustomers: 0, matchedProfiles: 0, totalCents: 0, error: String(e) };
  }

  const squareIds = [...agg.keys()];
  if (squareIds.length === 0) {
    return { ok: true, squareCustomers: 0, matchedProfiles: 0, totalCents: 0 };
  }

  // Square customer_id → client_profile_id (batched IN lookups).
  const idToProfile = new Map<string, string>();
  for (let i = 0; i < squareIds.length; i += 300) {
    const chunk = squareIds.slice(i, i + 300);
    const { data } = await db
      .from("client_profiles")
      .select("id, square_customer_id")
      .in("square_customer_id", chunk);
    for (const r of (data as { id: string; square_customer_id: string | null }[] | null) ?? []) {
      if (r.square_customer_id) idToProfile.set(r.square_customer_id, r.id);
    }
  }

  // Aggregate to the profile (a profile may link >1 Square customer after a merge).
  const byProfile = new Map<string, Agg>();
  for (const [cid, a] of agg) {
    const pid = idToProfile.get(cid);
    if (!pid) continue;
    const cur = byProfile.get(pid) ?? { total: 0, count: 0, lastAt: null };
    cur.total += a.total;
    cur.count += a.count;
    if (a.lastAt && (!cur.lastAt || a.lastAt > cur.lastAt)) cur.lastAt = a.lastAt;
    byProfile.set(pid, cur);
  }

  const now = new Date().toISOString();
  const rows = [...byProfile.entries()].map(([pid, a]) => ({
    salon_id: salonId,
    client_profile_id: pid,
    total_spend_cents: a.total,
    payment_count: a.count,
    last_payment_at: a.lastAt,
    synced_at: now,
  }));
  let totalCents = 0;
  for (const r of rows) totalCents += r.total_spend_cents;

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await db
      .from("salon_client_spend")
      .upsert(chunk as never, { onConflict: "salon_id,client_profile_id" });
    if (error) {
      return {
        ok: false,
        squareCustomers: agg.size,
        matchedProfiles: rows.length,
        totalCents,
        error: error.message,
      };
    }
  }

  return { ok: true, squareCustomers: agg.size, matchedProfiles: rows.length, totalCents };
}
