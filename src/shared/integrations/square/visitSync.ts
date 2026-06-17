import "server-only";
import { looseServiceClient } from "./looseDb";
import { getSquareConfig, type SquareConfig } from "./client";

const SQUARE_VERSION = "2024-10-17";

function apiBase(env: string): string {
  return env === "sandbox"
    ? "https://connect.squareupsandbox.com/v2"
    : "https://connect.squareup.com/v2";
}

type SquarePaymentRaw = {
  id?: string;
  status?: string;
  customer_id?: string;
  created_at?: string;
  amount_money?: { amount?: number };
  order_id?: string;
};

type SquareOrderRaw = {
  id?: string;
  line_items?: Array<{ name?: string }>;
};

/** Batch-retrieve Square order line item names. Returns map: order_id → service names[]. */
async function fetchOrderServiceNames(
  base: string,
  token: string,
  orderIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (orderIds.length === 0) return result;
  for (let i = 0; i < orderIds.length; i += 100) {
    const batch = orderIds.slice(i, i + 100);
    try {
      const res = await fetch(`${base}/orders/batch-retrieve`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Square-Version": SQUARE_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ order_ids: batch }),
      });
      if (!res.ok) continue;
      const j = (await res.json()) as { orders?: SquareOrderRaw[] };
      for (const order of j.orders ?? []) {
        if (!order.id) continue;
        const names = (order.line_items ?? [])
          .map((li) => (li.name ?? "").trim())
          .filter(Boolean);
        if (names.length > 0) result.set(order.id, names);
      }
    } catch {
      // best-effort; skip this batch and continue
    }
  }
  return result;
}

export type VisitSyncResult = {
  ok: boolean;
  paymentsScanned: number;
  upserted: number;
  withServices: number;
  error?: string;
};

/**
 * Sync per-visit history from Square payments into square_visit_history.
 *
 * Incremental by default: watermarks from MAX(square_created_at) − 2 days so
 * any reprocessed payments are caught. Pass `fullBackfill: true` for initial
 * historical load (scans all history, up to 300 pages = 30k payments).
 *
 * For each payment the function also batch-fetches its Square Order to extract
 * service names (e.g. "Hi-Lite Royal") for AI agent personalisation.
 */
export async function syncSquareVisitHistory(
  salonId: string,
  opts: { fullBackfill?: boolean } = {},
): Promise<VisitSyncResult> {
  const db = looseServiceClient();

  let cfg: SquareConfig;
  try {
    cfg = await getSquareConfig(db, salonId);
  } catch (e) {
    return { ok: false, paymentsScanned: 0, upserted: 0, withServices: 0, error: String(e) };
  }

  const base = apiBase(cfg.environment);

  // Watermark: re-scan from 2 days before the latest synced payment so that
  // any reprocessed or late-settled payments are captured.
  let since: string | undefined;
  if (!opts.fullBackfill) {
    const { data: wm } = await db
      .from("square_visit_history" as never)
      .select("square_created_at")
      .eq("salon_id", salonId)
      .order("square_created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const wmDate = (wm as { square_created_at?: string } | null)?.square_created_at;
    if (wmDate) {
      since = new Date(Date.parse(wmDate) - 2 * 86_400_000).toISOString();
    }
  }

  // Page through Square payments
  const payments: SquarePaymentRaw[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const pageLimit = opts.fullBackfill ? 300 : 50; // 50 × 100 = 5k payments for incremental
  do {
    const params = new URLSearchParams({
      location_id: cfg.locationId,
      limit: "100",
      sort_order: "ASC",
    });
    if (cursor) params.set("cursor", cursor);
    if (since) params.set("begin_time", since);
    const res = await fetch(`${base}/payments?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${cfg.accessToken}`,
        "Square-Version": SQUARE_VERSION,
      },
    });
    if (!res.ok) {
      return {
        ok: false,
        paymentsScanned: payments.length,
        upserted: 0,
        withServices: 0,
        error: `Square HTTP ${res.status}`,
      };
    }
    const j = (await res.json()) as {
      payments?: SquarePaymentRaw[];
      cursor?: string;
      errors?: unknown;
    };
    if (j.errors) {
      return {
        ok: false,
        paymentsScanned: payments.length,
        upserted: 0,
        withServices: 0,
        error: `Square error: ${JSON.stringify(j.errors)}`,
      };
    }
    for (const p of j.payments ?? []) {
      if (p.status === "COMPLETED" && p.customer_id && p.id && p.created_at) {
        payments.push(p);
      }
    }
    cursor = j.cursor;
    pages++;
  } while (cursor && pages < pageLimit);

  if (payments.length === 0) {
    return { ok: true, paymentsScanned: 0, upserted: 0, withServices: 0 };
  }

  // Map Square customer_id → NailIQ client_profile_id
  const squareIds = [...new Set(payments.map((p) => p.customer_id!))];
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

  // Batch-fetch Square Orders to get service names per visit
  const orderIds = [...new Set(payments.filter((p) => p.order_id).map((p) => p.order_id!))];
  const orderServiceMap = await fetchOrderServiceNames(base, cfg.accessToken, orderIds);

  // Build rows
  const now = new Date().toISOString();
  const rows = payments.map((p) => ({
    salon_id: salonId,
    client_profile_id: idToProfile.get(p.customer_id!) ?? null,
    square_customer_id: p.customer_id!,
    square_payment_id: p.id!,
    square_created_at: p.created_at!,
    // visit_date in LA timezone (Square stores created_at in UTC)
    visit_date: new Date(p.created_at!)
      .toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }),
    amount_cents: Number(p.amount_money?.amount ?? 0),
    order_id: p.order_id ?? null,
    service_names: p.order_id ? (orderServiceMap.get(p.order_id) ?? null) : null,
    synced_at: now,
  }));

  let upserted = 0;
  let withServices = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await db
      .from("square_visit_history" as never)
      .upsert(chunk as never, { onConflict: "salon_id,square_payment_id" });
    if (!error) {
      upserted += chunk.length;
      withServices += chunk.filter((r) => r.service_names && r.service_names.length > 0).length;
    }
  }

  return { ok: true, paymentsScanned: payments.length, upserted, withServices };
}

// ---------------------------------------------------------------------------
// Query helpers for AI agents
// ---------------------------------------------------------------------------

/** Daily revenue for the last N days. Used by Watchdog (revenue_anomaly) and Daily Reporter. */
export async function getDailyRevenueCents(
  salonId: string,
  days: number,
): Promise<{ date: string; revenue_cents: number }[]> {
  const db = looseServiceClient();
  const since = new Date(Date.now() - days * 86_400_000)
    .toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const { data } = await db
    .from("square_visit_history" as never)
    .select("visit_date, amount_cents")
    .eq("salon_id", salonId)
    .gte("visit_date", since)
    .order("visit_date", { ascending: true });
  const map = new Map<string, number>();
  for (const r of (data as { visit_date: string; amount_cents: number }[] | null) ?? []) {
    map.set(r.visit_date, (map.get(r.visit_date) ?? 0) + r.amount_cents);
  }
  return [...map.entries()].map(([date, revenue_cents]) => ({ date, revenue_cents }));
}

/** Service popularity by visit count + revenue for the last N days. Used by Chiến Lược Gia. */
export async function getServicePopularity(
  salonId: string,
  days: number,
): Promise<{ service: string; visits: number; revenue_cents: number }[]> {
  const db = looseServiceClient();
  const since = new Date(Date.now() - days * 86_400_000)
    .toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const { data } = await db
    .from("square_visit_history" as never)
    .select("service_names, amount_cents")
    .eq("salon_id", salonId)
    .gte("visit_date", since)
    .not("service_names", "is", null);
  const map = new Map<string, { visits: number; revenue_cents: number }>();
  for (const r of (data as { service_names: string[] | null; amount_cents: number }[] | null) ?? []) {
    for (const svc of r.service_names ?? []) {
      const cur = map.get(svc) ?? { visits: 0, revenue_cents: 0 };
      cur.visits++;
      cur.revenue_cents += r.amount_cents;
      map.set(svc, cur);
    }
  }
  return [...map.entries()]
    .map(([service, stats]) => ({ service, ...stats }))
    .sort((a, b) => b.visits - a.visits);
}

/**
 * Last N visits for a customer with amount and service names.
 * Used by VIP Care (milestone), Win-back prompt enrichment, and Rebook.
 */
export async function getCustomerVisitHistory(
  salonId: string,
  clientProfileId: string,
  limit = 10,
): Promise<{ date: string; amount_cents: number; services: string[] }[]> {
  const db = looseServiceClient();
  const { data } = await db
    .from("square_visit_history" as never)
    .select("visit_date, amount_cents, service_names")
    .eq("salon_id", salonId)
    .eq("client_profile_id", clientProfileId)
    .order("square_created_at", { ascending: false })
    .limit(limit);
  return (
    data as { visit_date: string; amount_cents: number; service_names: string[] | null }[] | null ?? []
  ).map((r) => ({
    date: r.visit_date,
    amount_cents: r.amount_cents,
    services: r.service_names ?? [],
  }));
}

/** Total visit count for a customer from Square (more accurate than booking count). */
export async function getCustomerVisitCount(
  salonId: string,
  clientProfileId: string,
): Promise<number> {
  const db = looseServiceClient();
  const { data } = await db
    .from("square_visit_history" as never)
    .select("id")
    .eq("salon_id", salonId)
    .eq("client_profile_id", clientProfileId);
  return (data as unknown[] | null)?.length ?? 0;
}
