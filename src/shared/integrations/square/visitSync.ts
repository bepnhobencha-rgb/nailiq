import "server-only";
import { loadSquareCustomerIdentityMap } from "./customerIdentity";
import { looseServiceClient } from "./looseDb";
import { getSquareConfig, type SquareConfig } from "./client";

const SQUARE_VERSION = "2024-10-17";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
): Promise<
  | { ok: true; serviceNames: Map<string, string[]> }
  | { ok: false; error: string }
> {
  const result = new Map<string, string[]>();
  if (orderIds.length === 0) return { ok: true, serviceNames: result };
  for (let i = 0; i < orderIds.length; i += 100) {
    const batch = orderIds.slice(i, i + 100);
    let res: Response;
    try {
      res = await fetch(`${base}/orders/batch-retrieve`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Square-Version": SQUARE_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ order_ids: batch }),
      });
    } catch {
      return { ok: false, error: "square_visit_order_provider_read_unavailable" };
    }
    if (!res.ok) {
      return { ok: false, error: "square_visit_order_provider_read_unavailable" };
    }
    let value: unknown;
    try {
      value = await res.json();
    } catch {
      return { ok: false, error: "square_visit_order_provider_response_invalid" };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "square_visit_order_provider_response_invalid" };
    }
    const payload = value as { orders?: unknown; errors?: unknown };
    if (
      (payload.errors !== undefined
        && (!Array.isArray(payload.errors) || payload.errors.length > 0))
      || (payload.orders !== undefined && !Array.isArray(payload.orders))
    ) {
      return { ok: false, error: "square_visit_order_provider_response_invalid" };
    }
    const requested = new Set(batch);
    const seen = new Set<string>();
    for (const value of payload.orders ?? []) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, error: "square_visit_order_provider_response_invalid" };
      }
      const order = value as SquareOrderRaw;
      if (
        typeof order.id !== "string"
        || !order.id
        || !requested.has(order.id)
        || seen.has(order.id)
        || (order.line_items !== undefined && !Array.isArray(order.line_items))
      ) {
        return { ok: false, error: "square_visit_order_provider_response_invalid" };
      }
      seen.add(order.id);
      const names: string[] = [];
      for (const lineItem of order.line_items ?? []) {
        if (
          !lineItem
          || typeof lineItem !== "object"
          || Array.isArray(lineItem)
          || (lineItem.name !== undefined && typeof lineItem.name !== "string")
        ) {
          return { ok: false, error: "square_visit_order_provider_response_invalid" };
        }
        const name = (lineItem.name ?? "").trim();
        if (name) names.push(name);
      }
      if (names.length > 0) result.set(order.id, names);
    }
  }
  return { ok: true, serviceNames: result };
}

export type VisitSyncResult = {
  ok: boolean;
  paymentsScanned: number;
  upserted: number;
  withServices: number;
  error?: string;
};

function failedVisitSync(
  error: string,
  paymentsScanned = 0,
  upserted = 0,
  withServices = 0,
): VisitSyncResult {
  return { ok: false, paymentsScanned, upserted, withServices, error };
}

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
  } catch {
    return failedVisitSync("square_visit_config_unavailable");
  }

  const base = apiBase(cfg.environment);

  // Watermark: re-scan from 2 days before the latest synced payment so that
  // any reprocessed or late-settled payments are captured.
  let since: string | undefined;
  if (!opts.fullBackfill) {
    const { data: wm, error: watermarkError } = await db
      .from("square_visit_history" as never)
      .select("square_created_at")
      .eq("salon_id", salonId)
      .order("square_created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (watermarkError) {
      return failedVisitSync("square_visit_watermark_unavailable");
    }
    const wmDate = (wm as { square_created_at?: string } | null)?.square_created_at;
    if (wmDate) {
      const watermarkMs = Date.parse(wmDate);
      if (!Number.isFinite(watermarkMs)) {
        return failedVisitSync("square_visit_watermark_invalid");
      }
      since = new Date(watermarkMs - 2 * 86_400_000).toISOString();
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
    let res: Response;
    try {
      res = await fetch(`${base}/payments?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${cfg.accessToken}`,
          "Square-Version": SQUARE_VERSION,
        },
      });
    } catch {
      return failedVisitSync(
        "square_visit_provider_read_unavailable",
        payments.length,
      );
    }
    if (!res.ok) {
      return failedVisitSync(
        "square_visit_provider_read_unavailable",
        payments.length,
      );
    }
    let j: {
      payments?: SquarePaymentRaw[];
      cursor?: string;
      errors?: unknown;
    };
    try {
      j = (await res.json()) as typeof j;
    } catch {
      return failedVisitSync(
        "square_visit_provider_response_invalid",
        payments.length,
      );
    }
    if (j.errors) {
      return failedVisitSync(
        "square_visit_provider_response_invalid",
        payments.length,
      );
    }
    for (const p of j.payments ?? []) {
      if (p.status === "COMPLETED" && p.customer_id && p.id && p.created_at) {
        payments.push(p);
      }
    }
    if (j.cursor !== undefined && typeof j.cursor !== "string") {
      return failedVisitSync(
        "square_visit_provider_response_invalid",
        payments.length,
      );
    }
    cursor = j.cursor;
    pages++;
  } while (cursor && pages < pageLimit);

  if (cursor) {
    return failedVisitSync(
      "square_visit_pagination_limit_exceeded",
      payments.length,
    );
  }

  if (payments.length === 0) {
    return { ok: true, paymentsScanned: 0, upserted: 0, withServices: 0 };
  }

  // Map only inside the exact Square environment + merchant namespace.
  const squareIds = [...new Set(payments.map((p) => p.customer_id!))];
  let idToProfile: Map<string, string>;
  try {
    idToProfile = await loadSquareCustomerIdentityMap(db, cfg, squareIds);
  } catch {
    return failedVisitSync(
      "square_visit_identity_map_unavailable",
      payments.length,
    );
  }

  // The scoped identity table deliberately has no unsafe legacy backfill. When
  // an exact account identity has not yet been rebuilt, retain only a profile
  // already attached to this exact salon + provider payment + customer tuple.
  // This prevents a replay from erasing valid history without inferring a link
  // from the old globally-unscoped Square customer id.
  const existingProfileByPayment = new Map<string, string>();
  const unmappedPayments = payments.filter((payment) => (
    !idToProfile.has(payment.customer_id!)
  ));
  const requestedPaymentCustomer = new Map<string, string>();
  for (const payment of unmappedPayments) {
    const paymentId = payment.id!;
    const customerId = payment.customer_id!;
    const previousCustomerId = requestedPaymentCustomer.get(paymentId);
    if (previousCustomerId && previousCustomerId !== customerId) {
      return failedVisitSync(
        "square_visit_provider_response_invalid",
        payments.length,
      );
    }
    requestedPaymentCustomer.set(paymentId, customerId);
  }
  const unmappedPaymentIds = [...requestedPaymentCustomer.keys()];
  for (let offset = 0; offset < unmappedPaymentIds.length; offset += 300) {
    const chunk = unmappedPaymentIds.slice(offset, offset + 300);
    const { data, error } = await db
      .from("square_visit_history" as never)
      .select("square_payment_id, square_customer_id, client_profile_id")
      .eq("salon_id", salonId)
      .in("square_payment_id", chunk);
    if (error || !Array.isArray(data)) {
      return failedVisitSync(
        "square_visit_existing_identity_lookup_unavailable",
        payments.length,
      );
    }
    for (const value of data) {
      const row = value as {
        square_payment_id?: unknown;
        square_customer_id?: unknown;
        client_profile_id?: unknown;
      };
      const paymentId = typeof row.square_payment_id === "string"
        ? row.square_payment_id : "";
      const customerId = typeof row.square_customer_id === "string"
        ? row.square_customer_id : "";
      const requestedCustomerId = requestedPaymentCustomer.get(paymentId);
      if (!requestedCustomerId || customerId !== requestedCustomerId) {
        return failedVisitSync(
          "square_visit_existing_identity_conflict",
          payments.length,
        );
      }
      if (row.client_profile_id === null) continue;
      const profileId = typeof row.client_profile_id === "string"
        ? row.client_profile_id.toLowerCase() : "";
      const previousProfileId = existingProfileByPayment.get(paymentId);
      if (!UUID_RE.test(profileId) || (previousProfileId && previousProfileId !== profileId)) {
        return failedVisitSync(
          "square_visit_existing_identity_response_invalid",
          payments.length,
        );
      }
      existingProfileByPayment.set(paymentId, profileId);
    }
  }

  // Batch-fetch Square Orders to get service names per visit
  const orderIds = [...new Set(payments.filter((p) => p.order_id).map((p) => p.order_id!))];
  const orderServices = await fetchOrderServiceNames(base, cfg.accessToken, orderIds);
  if (!orderServices.ok) {
    return failedVisitSync(orderServices.error, payments.length);
  }
  const orderServiceMap = orderServices.serviceNames;

  // Build rows
  const now = new Date().toISOString();
  const rows = payments.map((p) => ({
    salon_id: salonId,
    client_profile_id:
      idToProfile.get(p.customer_id!) ?? existingProfileByPayment.get(p.id!) ?? null,
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
    if (error) {
      return failedVisitSync(
        "square_visit_upsert_unavailable",
        payments.length,
        upserted,
        withServices,
      );
    }
    upserted += chunk.length;
    withServices += chunk.filter((r) => r.service_names && r.service_names.length > 0).length;
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
