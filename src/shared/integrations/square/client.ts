/**
 * Square REST client for NailIQ imports (customers, catalog, bookings).
 *
 * App-agnostic transport + thin Square-specific paginators. Credentials are
 * read from the per-salon `square_integrations` row (service-role only), never
 * hardcoded — mirrors the Wix integration's `client.ts` posture.
 */

const SQUARE_API = "https://connect.squareup.com/v2";
const SQUARE_SANDBOX_API = "https://connect.squareupsandbox.com/v2";
const SQUARE_VERSION = "2024-12-18";

export type SquareEnvironment = "production" | "sandbox";

export interface SquareConfig {
  salonId: string;
  merchantId: string;
  locationId: string;
  accessToken: string;
  /** Public Web Payments SDK app id (sq0idp-… / sandbox-sq0idb-…). */
  applicationId: string | null;
  environment: SquareEnvironment;
  /** ISO currency the salon's Square merchant transacts in (CAD/USD/…). Square
   *  rejects a charge whose currency ≠ the merchant's, so this MUST match the
   *  merchant — never hardcode. Sourced from salons.currency_code. */
  currency: string;
  /** Per-direction, per-operation sync switches (admin-controllable). PULL =
   *  Square→NailIQ (default on), PUSH = NailIQ→Square (default off, opt-in
   *  because it writes the salon's live Square calendar). */
  sync: {
    pullCreate: boolean;
    pullUpdate: boolean;
    pullCancel: boolean;
    pushCreate: boolean;
    pushUpdate: boolean;
    pushCancel: boolean;
  };
}

/** API base for the config's environment. */
function apiBase(cfg: SquareConfig): string {
  return cfg.environment === "sandbox" ? SQUARE_SANDBOX_API : SQUARE_API;
}

export interface SquareCustomer {
  id: string;
  given_name?: string;
  family_name?: string;
  phone_number?: string;
  email_address?: string;
  created_at?: string;
  creation_source?: string;
}

export interface SquareCatalogItem {
  id: string;
  name: string;
  description?: string;
  variations: { id: string; name?: string; priceCents: number | null; version?: number }[];
  isAddon: boolean;
}

export interface SquareBooking {
  id: string;
  status: string;
  /** Optimistic-concurrency version — required to cancel/update a booking. */
  version?: number;
  start_at?: string;
  customer_id?: string;
  location_id?: string;
  appointment_segments?: {
    duration_minutes?: number;
    service_variation_id?: string;
    team_member_id?: string;
  }[];
}

// Loosely typed: square_integrations isn't in the generated Database types yet,
// and both the service-role client and bare createClient() scripts pass through.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (table: string) => any };

/** Load Square credentials for a salon from the service-role DB. */
export async function getSquareConfig(db: Db, salonId: string): Promise<SquareConfig> {
  const { data, error } = await db
    .from("square_integrations")
    .select("salon_id, merchant_id, location_id, access_token, application_id, environment, sync_pull_create, sync_pull_update, sync_pull_cancel, sync_push_create, sync_push_update, sync_push_cancel")
    .eq("salon_id", salonId)
    .maybeSingle();
  if (error) throw new Error(`square_integrations load failed: ${JSON.stringify(error)}`);
  const row = data as {
    salon_id: string;
    merchant_id: string;
    location_id: string;
    access_token: string | null;
    application_id: string | null;
    environment: string | null;
    sync_pull_create: boolean | null;
    sync_pull_update: boolean | null;
    sync_pull_cancel: boolean | null;
    sync_push_create: boolean | null;
    sync_push_update: boolean | null;
    sync_push_cancel: boolean | null;
  } | null;
  if (!row) throw new Error(`No square_integrations row for salon ${salonId}`);
  if (!row.access_token) throw new Error(`square_integrations.access_token is empty for salon ${salonId}`);

  // Currency MUST match the salon's Square merchant (Square rejects a mismatch).
  // The salon's configured currency_code is the admin-set source of truth.
  const { data: salonRow } = await db
    .from("salons")
    .select("currency_code")
    .eq("id", salonId)
    .maybeSingle();
  const currency =
    String((salonRow as { currency_code?: string } | null)?.currency_code || "USD")
      .trim()
      .toUpperCase() || "USD";

  return {
    salonId: row.salon_id,
    merchantId: row.merchant_id,
    locationId: row.location_id,
    accessToken: row.access_token,
    applicationId: row.application_id ?? null,
    environment: row.environment === "sandbox" ? "sandbox" : "production",
    currency,
    sync: {
      // PULL defaults true (forward cron's long-standing behaviour), PUSH
      // defaults false (opt-in writes to the live Square calendar).
      pullCreate: row.sync_pull_create !== false,
      pullUpdate: row.sync_pull_update !== false,
      pullCancel: row.sync_pull_cancel !== false,
      pushCreate: row.sync_push_create === true,
      pushUpdate: row.sync_push_update === true,
      pushCancel: row.sync_push_cancel === true,
    },
  };
}

async function squareReq(
  cfg: SquareConfig,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiBase(cfg)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Square ${method} ${path} -> ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json;
}

/** Pull every customer for the merchant (paginated). */
export async function listAllCustomers(cfg: SquareConfig): Promise<SquareCustomer[]> {
  const out: SquareCustomer[] = [];
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = { limit: 100 };
    if (cursor) body.cursor = cursor;
    const json = await squareReq(cfg, "POST", "/customers/search", body);
    out.push(...((json.customers as SquareCustomer[]) ?? []));
    cursor = json.cursor as string | undefined;
  } while (cursor);
  return out;
}

/**
 * Create a Square hosted payment link (Quick Pay) for a fixed amount — used to
 * collect a booking deposit. `referenceId` ties the resulting order/payment back
 * to the NailIQ booking. Requires a unique idempotencyKey to avoid double-create.
 */
export async function createPaymentLink(
  cfg: SquareConfig,
  opts: { amountCents: number; name: string; referenceId: string; idempotencyKey: string; note?: string },
): Promise<{ id: string; url: string; orderId: string | null }> {
  const json = await squareReq(cfg, "POST", "/online-checkout/payment-links", {
    idempotency_key: opts.idempotencyKey,
    quick_pay: {
      name: opts.name,
      price_money: { amount: opts.amountCents, currency: cfg.currency },
      location_id: cfg.locationId,
    },
    payment_note: opts.note,
    checkout_options: { redirect_url: undefined },
    pre_populated_data: undefined,
    description: opts.referenceId,
  });
  const pl = (json.payment_link as Record<string, unknown>) ?? {};
  return { id: String(pl.id ?? ""), url: String(pl.url ?? ""), orderId: (pl.order_id as string) ?? null };
}

// ---------------------------------------------------------------------------
// No-show card-on-file (Option C): save a card at booking, charge only if the
// customer no-shows. Proven against sandbox: customer → CreateCard → CreatePayment.
// ---------------------------------------------------------------------------

/** Candidate phone formats to try against Square. Square stores/searches phone
 *  numbers in E.164 (e.g. "+12368894243"), but our DB keeps digits ("12368894243"
 *  / "2368894243"). Verified against prod: exact match needs the "+E.164" form.
 *  We try the most likely first; de-duplicated, falsy dropped. */
function phoneSearchCandidates(phone: string): string[] {
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return [];
  const last10 = digits.slice(-10);
  const cands = [
    `+${digits}`, // "+12368894243" (digits already carry country code)
    digits.length === 10 ? `+1${digits}` : "", // 10-digit NANP → +1
    last10.length === 10 ? `+1${last10}` : "", // strip extra prefix, NANP
    digits, // bare digits (older records)
  ].filter(Boolean);
  return Array.from(new Set(cands));
}

/** Find an existing Square customer by phone — READ ONLY, never creates. Tries
 *  E.164 variants (Square stores phones in E.164). Returns null when no match. */
export async function findSquareCustomerByPhone(
  cfg: SquareConfig,
  phone: string,
): Promise<string | null> {
  for (const candidate of phoneSearchCandidates(phone)) {
    try {
      const found = await squareReq(cfg, "POST", "/customers/search", {
        query: { filter: { phone_number: { exact: candidate } } },
        limit: 1,
      });
      const hit = (found.customers as Array<{ id?: string }> | undefined)?.[0];
      if (hit?.id) return hit.id;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/** Find-or-create a Square customer for this booking's contact. */
export async function ensureSquareCustomer(
  cfg: SquareConfig,
  opts: { name?: string | null; phone?: string | null; email?: string | null; referenceId: string; idempotencyKey: string },
): Promise<string> {
  // Match on phone first (the salon's primary key for a guest). Best-effort —
  // a phone Square rejects (e.g. fictional 555 numbers) must not break saving.
  // E.164-aware search (Square stores phones in E.164) avoids creating a
  // duplicate customer for a returning guest.
  if (opts.phone) {
    const existing = await findSquareCustomerByPhone(cfg, opts.phone);
    if (existing) return existing;
  }
  const parts = (opts.name ?? "").trim().split(/\s+/);
  const base = {
    given_name: parts[0] || undefined,
    family_name: parts.slice(1).join(" ") || undefined,
    email_address: opts.email || undefined,
    reference_id: opts.referenceId,
  };
  try {
    const json = await squareReq(cfg, "POST", "/customers", {
      idempotency_key: opts.idempotencyKey,
      phone_number: opts.phone || undefined,
      ...base,
    });
    const id = (json.customer as { id?: string } | undefined)?.id;
    if (id) return id;
  } catch (e) {
    // Square rejected the create (most likely the phone) — retry without it so
    // the card can still be saved against name/email.
    const json = await squareReq(cfg, "POST", "/customers", {
      idempotency_key: `${opts.idempotencyKey}-np`,
      ...base,
    });
    const id = (json.customer as { id?: string } | undefined)?.id;
    if (id) return id;
    throw e;
  }
  throw new Error("Square CreateCustomer returned no id");
}

/** Save a tokenized card (Web Payments SDK sourceId) on file for later charging. */
export async function saveCardOnFile(
  cfg: SquareConfig,
  opts: { customerId: string; sourceId: string; idempotencyKey: string },
): Promise<{ cardId: string; last4: string; brand: string }> {
  const json = await squareReq(cfg, "POST", "/cards", {
    idempotency_key: opts.idempotencyKey,
    source_id: opts.sourceId,
    card: { customer_id: opts.customerId },
  });
  const card = (json.card as Record<string, unknown>) ?? {};
  const cardId = String(card.id ?? "");
  if (!cardId) throw new Error("Square CreateCard returned no id");
  return { cardId, last4: String(card.last_4 ?? ""), brand: String(card.card_brand ?? "") };
}

/** Charge a saved card-on-file (used to collect the no-show fee). */
export async function chargeSavedCard(
  cfg: SquareConfig,
  opts: { cardId: string; customerId: string; amountCents: number; idempotencyKey: string; note?: string; referenceId?: string },
): Promise<{ paymentId: string; status: string }> {
  const json = await squareReq(cfg, "POST", "/payments", {
    idempotency_key: opts.idempotencyKey,
    source_id: opts.cardId,
    customer_id: opts.customerId,
    amount_money: { amount: opts.amountCents, currency: cfg.currency },
    location_id: cfg.locationId,
    autocomplete: true,
    note: opts.note,
    reference_id: opts.referenceId,
    // Stored-credential / merchant-initiated flags. The no-show fee is charged
    // while the customer is NOT present, against a card they previously agreed
    // to keep on file → customer_initiated:false marks it merchant-initiated
    // (MIT) and seller_keyed_in:false says we're charging a vaulted card, not
    // typing one (not MOTO). Correct flagging is the card networks' required
    // basis for winning a no-show chargeback dispute.
    customer_details: { customer_initiated: false, seller_keyed_in: false },
  });
  const p = (json.payment as Record<string, unknown>) ?? {};
  return { paymentId: String(p.id ?? ""), status: String(p.status ?? "") };
}

/** List a customer's saved cards on file (enabled only by default). Used by
 *  returning-customer card reuse + the customer-facing card manager. */
export async function listCards(
  cfg: SquareConfig,
  customerId: string,
): Promise<Array<{ cardId: string; last4: string; brand: string; expMonth?: number; expYear?: number }>> {
  const json = await squareReq(cfg, "GET", `/cards?customer_id=${encodeURIComponent(customerId)}`);
  const cards = (json.cards as Record<string, unknown>[] | undefined) ?? [];
  return cards.map((c) => ({
    cardId: String(c.id ?? ""),
    last4: String(c.last_4 ?? ""),
    brand: String(c.card_brand ?? ""),
    expMonth: typeof c.exp_month === "number" ? c.exp_month : undefined,
    expYear: typeof c.exp_year === "number" ? c.exp_year : undefined,
  }));
}

/** Disable (remove) a saved card on file. Square has no hard delete — a
 *  disabled card can never be charged again, which is the removal path the
 *  stored-credential rules require us to offer the cardholder. */
export async function disableCard(cfg: SquareConfig, cardId: string): Promise<void> {
  await squareReq(cfg, "POST", `/cards/${encodeURIComponent(cardId)}/disable`);
}

/** Refund a payment (used to return a deposit on a mutually-agreed cancel). */
export async function refundPayment(
  cfg: SquareConfig,
  opts: { paymentId: string; amountCents: number; reason: string; idempotencyKey: string },
): Promise<{ id: string; status: string }> {
  const json = await squareReq(cfg, "POST", "/refunds", {
    idempotency_key: opts.idempotencyKey,
    payment_id: opts.paymentId,
    amount_money: { amount: opts.amountCents, currency: cfg.currency },
    reason: opts.reason,
  });
  const r = (json.refund as Record<string, unknown>) ?? {};
  return { id: String(r.id ?? ""), status: String(r.status ?? "") };
}

/** Retrieve an order to check whether a payment-link deposit has been paid. */
export async function getOrder(cfg: SquareConfig, orderId: string): Promise<{ state: string; paidCents: number; tenderPaymentId: string | null }> {
  const json = await squareReq(cfg, "GET", `/orders/${orderId}`);
  const o = (json.order as Record<string, unknown>) ?? {};
  const tenders = (o.tenders as Record<string, unknown>[]) ?? [];
  const paid = ((o.net_amount_due_money as Record<string, unknown>)?.amount as number | undefined);
  const total = ((o.total_money as Record<string, unknown>)?.amount as number | undefined) ?? 0;
  return {
    state: String(o.state ?? ""),
    paidCents: paid != null ? total - paid : (tenders.length ? total : 0),
    tenderPaymentId: (tenders[0]?.payment_id as string) ?? null,
  };
}

/** Retrieve a single customer by id (for on-demand import during sync). */
export async function getCustomer(cfg: SquareConfig, customerId: string): Promise<SquareCustomer | null> {
  const json = await squareReq(cfg, "GET", `/customers/${customerId}`);
  return (json.customer as SquareCustomer) ?? null;
}

/** Pull catalog ITEMs with their variations + price, flagging add-ons. */
export async function listCatalogItems(cfg: SquareConfig): Promise<SquareCatalogItem[]> {
  const out: SquareCatalogItem[] = [];
  let cursor: string | undefined;
  do {
    const body: Record<string, unknown> = { object_types: ["ITEM"], limit: 200 };
    if (cursor) body.cursor = cursor;
    const json = await squareReq(cfg, "POST", "/catalog/search", body);
    for (const o of (json.objects as Record<string, unknown>[]) ?? []) {
      const it = (o.item_data as Record<string, unknown>) ?? {};
      const variations = ((it.variations as Record<string, unknown>[]) ?? []).map((v) => {
        const vd = (v.item_variation_data as Record<string, unknown>) ?? {};
        const pm = (vd.price_money as Record<string, unknown>) ?? {};
        return {
          id: v.id as string,
          name: vd.name as string | undefined,
          priceCents: (pm.amount as number | undefined) ?? null,
          // Catalog object version — required as service_variation_version when
          // creating a Square booking (reverse sync).
          version: typeof v.version === "number" ? (v.version as number) : undefined,
        };
      });
      out.push({
        id: o.id as string,
        name: (it.name as string) ?? "",
        description: it.description as string | undefined,
        variations,
        isAddon: false, // Square has no add-on flag; caller decides from name/price.
      });
    }
    cursor = json.cursor as string | undefined;
  } while (cursor);
  return out;
}

/** Rename a Square team member (sparse update — only the given fields change). */
export async function updateTeamMemberName(
  cfg: SquareConfig,
  teamMemberId: string,
  givenName: string,
  familyName = "",
): Promise<void> {
  await squareReq(cfg, "PUT", `/team-members/${teamMemberId}`, {
    team_member: { given_name: givenName, family_name: familyName },
  });
}

export interface SquarePayment {
  id: string;
  status: string;
  created_at?: string;
  amount_money?: { amount?: number; currency?: string };
  tip_money?: { amount?: number };
  refunded_money?: { amount?: number };
  source_type?: string;
}

/** Pull completed payments for the location in [begin, end) (paginated). */
export async function listPayments(
  cfg: SquareConfig,
  begin: Date,
  end: Date,
): Promise<SquarePayment[]> {
  const out: SquarePayment[] = [];
  let cursor: string | undefined;
  do {
    const qs = new URLSearchParams({
      location_id: cfg.locationId,
      begin_time: begin.toISOString(),
      end_time: end.toISOString(),
      sort_order: "ASC",
      limit: "100",
    });
    if (cursor) qs.set("cursor", cursor);
    const json = await squareReq(cfg, "GET", `/payments?${qs.toString()}`);
    out.push(...((json.payments as SquarePayment[]) ?? []));
    cursor = json.cursor as string | undefined;
  } while (cursor);
  return out;
}

/**
 * List bookings for the configured location across a date range. Square caps
 * each query at 31 days, so we walk the window month-by-month.
 */
export async function listBookings(
  cfg: SquareConfig,
  startAtMin: Date,
  startAtMax: Date,
): Promise<SquareBooking[]> {
  const out: SquareBooking[] = [];
  const DAY = 86_400_000;
  let windowStart = startAtMin.getTime();
  const end = startAtMax.getTime();
  while (windowStart < end) {
    const windowEnd = Math.min(windowStart + 30 * DAY, end);
    let cursor: string | undefined;
    do {
      const qs = new URLSearchParams({
        location_id: cfg.locationId,
        start_at_min: new Date(windowStart).toISOString(),
        start_at_max: new Date(windowEnd).toISOString(),
        limit: "200",
      });
      if (cursor) qs.set("cursor", cursor);
      const json = await squareReq(cfg, "GET", `/bookings?${qs.toString()}`);
      out.push(...((json.bookings as SquareBooking[]) ?? []));
      cursor = json.cursor as string | undefined;
    } while (cursor);
    windowStart = windowEnd;
  }
  return out;
}

/**
 * Cancel a Square booking (NailIQ → Square reverse sync, Tầng 1). `version` is
 * Square's optimistic-concurrency token from the latest fetch; a stale version
 * makes Square reject the call (the caller should re-fetch + retry). The
 * idempotency key is stable per (booking, version) so a retry never
 * double-cancels. Throws on API error (caller logs + continues — one failed
 * cancel must not crash the sync run).
 */
export async function cancelSquareBooking(
  cfg: SquareConfig,
  bookingId: string,
  version: number,
): Promise<void> {
  await squareReq(cfg, "POST", `/bookings/${encodeURIComponent(bookingId)}/cancel`, {
    idempotency_key: `cancel:${bookingId}:${version}`,
    booking_version: version,
  });
}

/**
 * Create a Square booking (NailIQ → Square reverse sync, Tầng 2) so a booking
 * made in NailIQ also appears on the Square calendar (prevents Square-side
 * double-booking of the slot). `idempotencyKey` MUST be stable per NailIQ
 * booking (e.g. `create:<bookingId>`) — if we create in Square but fail to store
 * the id, the next run reuses the key and Square returns the SAME booking
 * instead of a duplicate. Returns the new Square booking id. Throws on API error.
 */
export async function createSquareBooking(
  cfg: SquareConfig,
  opts: {
    startAtIso: string;
    customerId: string;
    teamMemberId: string;
    serviceVariationId: string;
    serviceVariationVersion: number;
    durationMinutes: number;
    sellerNote?: string;
    idempotencyKey: string;
  },
): Promise<{ id: string; version: number }> {
  const json = await squareReq(cfg, "POST", "/bookings", {
    idempotency_key: opts.idempotencyKey,
    booking: {
      location_id: cfg.locationId,
      start_at: opts.startAtIso,
      customer_id: opts.customerId,
      seller_note: opts.sellerNote || undefined,
      appointment_segments: [
        {
          team_member_id: opts.teamMemberId,
          service_variation_id: opts.serviceVariationId,
          service_variation_version: opts.serviceVariationVersion,
          duration_minutes: opts.durationMinutes,
        },
      ],
    },
  });
  const b = (json.booking as { id?: string; version?: number } | undefined) ?? {};
  if (!b.id) throw new Error("Square CreateBooking returned no id");
  return { id: b.id, version: typeof b.version === "number" ? b.version : 0 };
}
