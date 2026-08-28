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
  if (cfg.environment === "sandbox") return SQUARE_SANDBOX_API;
  if (cfg.environment === "production") return SQUARE_API;
  throw new Error("Square environment is invalid");
}

export interface SquareCustomer {
  id: string;
  given_name?: string;
  family_name?: string;
  phone_number?: string;
  email_address?: string;
  created_at?: string;
  creation_source?: string;
  /** Square marketing preferences. `email_unsubscribed=false` (the default for a
   *  subscriber) means the customer still consents to EMAIL marketing. Returned
   *  by /customers/search on the Customer object. */
  preferences?: { email_unsubscribed?: boolean };
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
  /** RFC3339 last-update time — used for reschedule last-writer-wins vs NailIQ. */
  updated_at?: string;
  start_at?: string;
  customer_id?: string;
  location_id?: string;
  seller_note?: string;
  appointment_segments?: {
    duration_minutes?: number;
    service_variation_id?: string;
    service_variation_version?: number;
    team_member_id?: string;
  }[];
}

class SquareHttpError extends Error {
  readonly status: number;
  readonly codes: string[];

  constructor(message: string, status: number, codes: string[]) {
    super(message);
    this.name = "SquareHttpError";
    this.status = status;
    this.codes = codes;
  }
}

function squareErrorCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const codes: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return [];
    const code = (item as { code?: unknown }).code;
    if (typeof code !== "string" || code.length === 0) return [];
    codes.push(code);
  }
  return codes;
}

function isDefinitiveInvalidPhoneError(error: unknown): boolean {
  return error instanceof SquareHttpError
    && error.status === 400
    && error.codes.length > 0
    && error.codes.every((code) => code === "INVALID_PHONE_NUMBER");
}

function noPhoneCustomerIdempotencyKey(baseKey: string): string {
  const booking = /^sqcust:([0-9a-f-]{36})$/i.exec(baseKey);
  if (booking) return `sqc:${booking[1]}-np`;
  const cardSetup = /^([0-9a-f-]{36}):customer$/i.exec(baseKey);
  if (cardSetup) return `sqpc:${cardSetup[1]}-np`;
  const candidate = `${baseKey}-np`;
  if (candidate.length > 45) {
    throw new Error("Square no-phone customer idempotency key is too long");
  }
  return candidate;
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
  if (row.environment !== "sandbox" && row.environment !== "production") {
    throw new Error(`square_integrations.environment is invalid for salon ${salonId}`);
  }

  // Currency MUST match the salon's Square merchant (Square rejects a mismatch).
  // The salon's configured currency_code is the admin-set source of truth.
  const { data: salonRow, error: salonCurrencyError } = await db
    .from("salons")
    .select("currency_code")
    .eq("id", salonId)
    .maybeSingle();
  if (salonCurrencyError || !salonRow) {
    throw new Error("square_salon_currency_unavailable");
  }
  const currency = String(
    (salonRow as { currency_code?: string } | null)?.currency_code ?? "",
  ).trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw new Error("square_salon_currency_invalid");
  }

  return {
    salonId: row.salon_id,
    merchantId: row.merchant_id,
    locationId: row.location_id,
    accessToken: row.access_token,
    applicationId: row.application_id ?? null,
    environment: row.environment,
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
  apiVersion = SQUARE_VERSION,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${apiBase(cfg)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.accessToken}`,
      "Square-Version": apiVersion,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const errors = json.errors;
    throw new SquareHttpError(
      `Square ${method} ${path} -> ${res.status}: ${JSON.stringify(errors ?? json)}`,
      res.status,
      squareErrorCodes(errors),
    );
  }
  return json;
}

/**
 * Read one provider catalog page for the optional Inventory worker. The caller
 * owns durable claim/reconciliation and response sanitization. Keeping this in
 * the central client prevents worker code from constructing ad-hoc transports.
 */
export async function searchSquareInventoryCatalogObjects(
  cfg: SquareConfig,
  request: Record<string, unknown>,
  apiVersion: string,
): Promise<Record<string, unknown>> {
  return squareReq(cfg, "POST", "/catalog/search", request, apiVersion);
}

/** Create a Square-assigned digital gift card. The provider-generated GAN is
 * deliberately not returned so callers cannot persist or log spendable card
 * credentials. Durable idempotency and receipt validation belong to the
 * issuance worker. */
export async function createSquareDigitalGiftCard(
  cfg: SquareConfig,
  input: { idempotencyKey: string },
  apiVersion: string,
): Promise<Record<string, unknown>> {
  return squareReq(cfg, "POST", "/gift-cards", {
    idempotency_key: input.idempotencyKey,
    location_id: cfg.locationId,
    gift_card: { type: "DIGITAL" },
  }, apiVersion);
}

/** Collect the already-authorized buyer payment for a gift-card order. */
export async function createSquareGiftCardPayment(
  cfg: SquareConfig,
  input: {
    idempotencyKey: string;
    sourceId: string;
    amountCents: number;
    currency: string;
    orderId: string;
  },
  apiVersion: string,
): Promise<Record<string, unknown>> {
  return squareReq(cfg, "POST", "/payments", {
    idempotency_key: input.idempotencyKey,
    source_id: input.sourceId,
    amount_money: { amount: input.amountCents, currency: input.currency },
    autocomplete: true,
    accept_partial_authorization: false,
    order_id: input.orderId,
    location_id: cfg.locationId,
  }, apiVersion);
}

/** Activate a paid gift card against the exact Square gift-card order line. */
export async function activateSquareGiftCard(
  cfg: SquareConfig,
  input: {
    idempotencyKey: string;
    giftCardId: string;
    orderId: string;
    lineItemUid: string;
  },
  apiVersion: string,
): Promise<Record<string, unknown>> {
  return squareReq(cfg, "POST", "/gift-cards/activities", {
    idempotency_key: input.idempotencyKey,
    gift_card_activity: {
      gift_card_id: input.giftCardId,
      type: "ACTIVATE",
      location_id: cfg.locationId,
      activate_activity_details: {
        order_id: input.orderId,
        line_item_uid: input.lineItemUid,
      },
    },
  }, apiVersion);
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
    // A failed read is not proof that the customer does not exist. Propagate
    // transport/provider errors so callers cannot turn an unknown search into a
    // duplicate CreateCustomer mutation under a fresh idempotency key.
    const found = await squareReq(cfg, "POST", "/customers/search", {
      query: { filter: { phone_number: { exact: candidate } } },
      limit: 1,
    });
    // Square documents a successful search with no matches as an empty JSON
    // object (`{}`), so an omitted `customers` field is a definitive empty
    // result. Keep every other unexpected shape fail-closed: a malformed read
    // must never be mistaken for permission to create a duplicate customer.
    const customers = found.customers === undefined ? [] : found.customers;
    const responseErrors = found.errors;
    if (
      (responseErrors !== undefined
        && (!Array.isArray(responseErrors) || responseErrors.length > 0))
      || !Array.isArray(customers)
      || customers.some((customer) => (
        !customer
        || typeof customer !== "object"
        || typeof (customer as { id?: unknown }).id !== "string"
        || !(customer as { id: string }).id.trim()
      ))
      || (customers.length === 0
        && found.cursor !== undefined
        && found.cursor !== null
        && found.cursor !== "")
    ) {
      throw new Error("Square SearchCustomers returned an invalid response");
    }
    const hit = customers[0] as { id: string } | undefined;
    if (hit) return hit.id;
  }
  return null;
}

/** Find-or-create a Square customer for this booking's contact. */
export async function ensureSquareCustomer(
  cfg: SquareConfig,
  opts: { name?: string | null; phone?: string | null; email?: string | null; referenceId: string; idempotencyKey: string },
): Promise<string> {
  // Match on phone first (the salon's primary key for a guest). An unsuccessful
  // provider response must propagate: only a successful empty search proves it
  // is safe to attempt CreateCustomer.
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
    const id = (json.customer as { id?: unknown } | undefined)?.id;
    if (typeof id === "string" && id.trim()) return id;
  } catch (e) {
    // A second idempotency key is safe only when Square definitively rejected
    // this exact request because of the phone. Transport failures, 5xxs and
    // unknown/mixed 4xx responses may have created the customer, so replaying
    // under a different key could create a duplicate.
    if (!isDefinitiveInvalidPhoneError(e)) throw e;
    const json = await squareReq(cfg, "POST", "/customers", {
      // Square caps idempotency keys at 45 characters. Keep the explicit `-np`
      // namespace while deriving a collision-resistant UUID form for NailIQ's
      // longer durable base keys.
      idempotency_key: noPhoneCustomerIdempotencyKey(opts.idempotencyKey),
      ...base,
    });
    const id = (json.customer as { id?: unknown } | undefined)?.id;
    if (typeof id === "string" && id.trim()) return id;
    throw e;
  }
  throw new Error("Square CreateCustomer returned no id");
}

/** Save a tokenized card (Web Payments SDK sourceId) on file for later charging. */
export async function saveCardOnFile(
  cfg: SquareConfig,
  opts: {
    customerId: string;
    sourceId: string;
    idempotencyKey: string;
    referenceId: string;
    /** Optional legacy verification token. Current Web Payments SDK clients
     *  request STORE verification during `card.tokenize(details)`, embedding
     *  the buyer-verification result in the source token. */
    verificationToken?: string;
  },
): Promise<{ cardId: string; last4: string; brand: string }> {
  const json = await squareReq(cfg, "POST", "/cards", {
    idempotency_key: opts.idempotencyKey,
    source_id: opts.sourceId,
    ...(opts.verificationToken
      ? { verification_token: opts.verificationToken }
      : {}),
    card: { customer_id: opts.customerId, reference_id: opts.referenceId },
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

/** Customer-present one-time charge from a Web Payments SDK token. The DB
 * operation owns amount/account/idempotency; this helper accepts no fallback
 * merchant or generated key. */
export async function chargeCardToken(
  cfg: SquareConfig,
  opts: {
    sourceId: string;
    amountCents: number;
    idempotencyKey: string;
    referenceId: string;
  },
): Promise<{ paymentId: string; status: string }> {
  const json = await squareReq(cfg, "POST", "/payments", {
    idempotency_key: opts.idempotencyKey,
    source_id: opts.sourceId,
    amount_money: { amount: opts.amountCents, currency: cfg.currency },
    location_id: cfg.locationId,
    autocomplete: true,
    note: "Booking deposit",
    reference_id: opts.referenceId,
    customer_details: { customer_initiated: true, seller_keyed_in: false },
  });
  const payment = (json.payment as Record<string, unknown>) ?? {};
  const paymentId = String(payment.id ?? "").trim();
  const status = String(payment.status ?? "").trim();
  if (!paymentId || !status) throw new Error("Square CreatePayment returned no receipt");
  return { paymentId, status };
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

/** Read-only response-loss recovery. The reference is unique per durable
 * operation, so callers never need to re-submit the source token. */
export async function listCardsByReferenceId(
  cfg: SquareConfig,
  referenceId: string,
): Promise<Array<{
  cardId: string;
  customerId: string;
  last4: string;
  brand: string;
  enabled: boolean;
  referenceId: string;
}>> {
  const json = await squareReq(
    cfg,
    "GET",
    `/cards?reference_id=${encodeURIComponent(referenceId)}&include_disabled=true`,
  );
  const cards = (json.cards as Record<string, unknown>[] | undefined) ?? [];
  return cards.map((card) => ({
    cardId: String(card.id ?? "").trim(),
    customerId: String(card.customer_id ?? "").trim(),
    last4: String(card.last_4 ?? "").trim(),
    brand: String(card.card_brand ?? "").trim(),
    enabled: card.enabled !== false,
    referenceId: String(card.reference_id ?? "").trim(),
  }));
}

/** Disable (remove) a saved card on file. Square has no hard delete — a
 *  disabled card can never be charged again, which is the removal path the
 *  stored-credential rules require us to offer the cardholder. */
export async function disableCard(cfg: SquareConfig, cardId: string): Promise<void> {
  try {
    await squareReq(cfg, "POST", `/cards/${encodeURIComponent(cardId)}/disable`);
  } catch (cause) {
    // Response loss after Square accepted the disable is recoverable: read the
    // exact card and treat the already-disabled state as success. Never infer
    // success from the transport error alone.
    try {
      const value = await squareReq(cfg, "GET", `/cards/${encodeURIComponent(cardId)}`);
      const card = value.card as Record<string, unknown> | undefined;
      if (card?.enabled === false) return;
    } catch {
      // Preserve the original ambiguous provider outcome.
    }
    throw cause;
  }
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
  const id = typeof r.id === "string" ? r.id.trim() : "";
  const status = typeof r.status === "string" ? r.status.trim() : "";
  const paymentId = typeof r.payment_id === "string" ? r.payment_id.trim() : "";
  const money = r.amount_money && typeof r.amount_money === "object"
    ? r.amount_money as Record<string, unknown>
    : null;
  const amount = typeof money?.amount === "number" && Number.isSafeInteger(money.amount)
    ? money.amount
    : null;
  const currency = typeof money?.currency === "string"
    ? money.currency.trim().toUpperCase()
    : "";
  if (!id || id.length > 255 || !status || status.length > 64 ||
      paymentId !== opts.paymentId || amount !== opts.amountCents ||
      currency !== cfg.currency.toUpperCase()) {
    throw new Error("Square RefundPayment returned no exact receipt");
  }
  return { id, status };
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
  // A deleted / missing Square customer (404) is a definitive guest fallback.
  // Auth, rate-limit, provider, transport and response failures are ambiguous:
  // fail the run with a stable PII-free code so integration health cannot be
  // cleared while customer linkage is unavailable.
  try {
    const json = await squareReq(cfg, "GET", `/customers/${encodeURIComponent(customerId)}`);
    const customer = json.customer;
    const optionalStringFields = [
      "given_name",
      "family_name",
      "phone_number",
      "email_address",
    ] as const;
    if (
      !customer
      || typeof customer !== "object"
      || Array.isArray(customer)
      || typeof (customer as { id?: unknown }).id !== "string"
      || !(customer as { id: string }).id
      || optionalStringFields.some((field) => {
        const value = (customer as Record<string, unknown>)[field];
        return value != null && typeof value !== "string";
      })
    ) {
      throw new Error("square_customer_lookup_failed");
    }
    return customer as SquareCustomer;
  } catch (e) {
    if (e instanceof SquareHttpError && e.status === 404) return null;
    throw new Error("square_customer_lookup_failed");
  }
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
  location_id?: string;
  amount_money?: { amount?: number; currency?: string };
  tip_money?: { amount?: number };
  refunded_money?: { amount?: number };
  source_type?: string;
  application_details?: { application_id?: string };
  /** Stable caller reference set at charge time, e.g. "booking:<id>". Square
   *  returns it on the payment object; used to reconcile a charge whose local
   *  DB write failed, before a retry would re-charge. */
  reference_id?: string;
}

export interface ExactSquarePaymentQuery {
  referenceId: string;
  amountCents: number;
  currency: string;
  /** Inclusive RFC3339 lower bound sent to Square ListPayments. */
  beginTime: string;
  /** RFC3339 upper bound sent to Square ListPayments. */
  endTime: string;
}

const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_EXACT_PAYMENT_PAGES = 5;

function parseRfc3339(value: string): number | null {
  if (!RFC3339_RE.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Recover one completed Square payment after an ambiguous create response.
 *
 * This intentionally treats a reused reference with different receipt
 * material as a conflict, not as "not found": retrying a mutation in that
 * state could collect twice. All pages are read so a duplicate cannot hide
 * behind the first exact match. The scan is bounded to 5 x 100 responses; an
 * unfinished result set fails closed instead of returning incomplete proof.
 */
export async function findExactSquarePaymentByReference(
  cfg: SquareConfig,
  query: ExactSquarePaymentQuery,
  apiVersion = SQUARE_VERSION,
): Promise<SquarePayment | null> {
  const beginMs = parseRfc3339(query.beginTime);
  const endMs = parseRfc3339(query.endTime);
  if (
    !query.referenceId
    || query.referenceId.length > 192
    || !Number.isSafeInteger(query.amountCents)
    || query.amountCents < 1
    || !/^[A-Z]{3}$/.test(query.currency)
    || !cfg.applicationId
    || beginMs === null
    || endMs === null
    || beginMs >= endMs
  ) {
    throw new Error("square_payment_recovery_query_invalid");
  }

  const referenced: SquarePayment[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_EXACT_PAYMENT_PAGES; page += 1) {
    const params = new URLSearchParams({
      location_id: cfg.locationId,
      begin_time: query.beginTime,
      end_time: query.endTime,
      sort_order: "ASC",
      limit: "100",
    });
    if (cursor) params.set("cursor", cursor);
    const json = await squareReq(
      cfg,
      "GET",
      `/payments?${params.toString()}`,
      undefined,
      apiVersion,
    );
    const payments = json.payments;
    if (payments !== undefined && !Array.isArray(payments)) {
      throw new Error("square_payment_recovery_response_invalid");
    }
    for (const payment of (payments ?? []) as SquarePayment[]) {
      if (payment?.reference_id === query.referenceId) referenced.push(payment);
    }
    if (referenced.length > 1) {
      throw new Error("square_payment_recovery_multiple_matches");
    }

    const nextCursor = json.cursor;
    if (nextCursor === undefined || nextCursor === null || nextCursor === "") {
      cursor = undefined;
      break;
    }
    if (typeof nextCursor !== "string" || nextCursor === cursor) {
      throw new Error("square_payment_recovery_response_invalid");
    }
    cursor = nextCursor;
  }
  if (cursor) throw new Error("square_payment_recovery_pagination_limit_exceeded");
  if (referenced.length === 0) return null;

  const payment = referenced[0];
  const createdMs = typeof payment.created_at === "string"
    ? parseRfc3339(payment.created_at)
    : null;
  if (
    typeof payment.id !== "string"
    || payment.id.length === 0
    || payment.status !== "COMPLETED"
    || payment.location_id !== cfg.locationId
    || payment.amount_money?.amount !== query.amountCents
    || payment.amount_money?.currency !== query.currency
    || payment.application_details?.application_id !== cfg.applicationId
    || createdMs === null
    || createdMs < beginMs
    || createdMs > endMs
  ) {
    throw new Error("square_payment_recovery_receipt_invalid");
  }
  return payment;
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
 * Find the most recent SUCCESSFUL payment whose reference_id matches `referenceId`
 * (e.g. "booking:<id>") within [since, now]. Used to reconcile a charge that
 * went through Square but whose local DB write failed — so a retry doesn't
 * re-charge. Returns null when none. Read-only.
 */
export async function findSuccessfulPaymentByReference(
  cfg: SquareConfig,
  referenceId: string,
  since: Date,
): Promise<SquarePayment | null> {
  const payments = await listPayments(cfg, since, new Date());
  const match = payments
    .filter(
      (p) =>
        p.reference_id === referenceId &&
        (p.status === "COMPLETED" || p.status === "APPROVED"),
    )
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return match[0] ?? null;
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
 * double-cancels. Throws on API error; the caller fails the sync run so
 * integration and cron health cannot be cleared after a provider failure.
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
  const b = (json.booking as Record<string, unknown> | undefined) ?? {};
  const segments = b.appointment_segments;
  const segment = Array.isArray(segments) ? segments[0] : null;
  const startAt = typeof b.start_at === "string" ? Date.parse(b.start_at) : Number.NaN;
  if (
    typeof b.id !== "string"
    || !b.id.trim()
    || b.id.length > 255
    || /[\u0000-\u001f\u007f]/.test(b.id)
    || !Number.isSafeInteger(b.version)
    || Number(b.version) < 0
    || b.location_id !== cfg.locationId
    || b.customer_id !== opts.customerId
    || !["ACCEPTED", "PENDING"].includes(String(b.status ?? ""))
    || !Number.isFinite(startAt)
    || startAt !== Date.parse(opts.startAtIso)
    || (opts.sellerNote
      ? b.seller_note !== opts.sellerNote
      : b.seller_note != null && b.seller_note !== "")
    || !Array.isArray(segments)
    || segments.length !== 1
    || !segment
    || typeof segment !== "object"
    || (segment as Record<string, unknown>).duration_minutes !== opts.durationMinutes
    || (segment as Record<string, unknown>).team_member_id !== opts.teamMemberId
    || (segment as Record<string, unknown>).service_variation_id
      !== opts.serviceVariationId
    || (segment as Record<string, unknown>).service_variation_version
      !== opts.serviceVariationVersion
  ) {
    // The provider mutation may already have committed, so an incomplete
    // response is an ambiguous outcome. Never manufacture version=0 and bind
    // it as an exact receipt; the durable writeback journal will reconcile it
    // through ListBookings on a later run.
    throw new Error("Square CreateBooking returned no exact receipt");
  }
  return { id: b.id, version: Number(b.version) };
}

/**
 * Reschedule a Square booking (NailIQ → Square reverse sync, Tầng 3). `version`
 * is Square's optimistic-concurrency token from the latest fetch — a stale one
 * makes Square reject the update (the caller logs + retries next run). The
 * appointment segment must be re-sent in full; pass the existing
 * team_member_id / service_variation_id / version with the NEW start + duration.
 * Idempotency key is stable per (booking, version) so a retry never double-applies.
 */
export async function updateSquareBookingTime(
  cfg: SquareConfig,
  opts: {
    bookingId: string;
    version: number;
    startAtIso: string;
    teamMemberId: string;
    serviceVariationId: string;
    serviceVariationVersion: number;
    durationMinutes: number;
  },
): Promise<void> {
  await squareReq(cfg, "PUT", `/bookings/${encodeURIComponent(opts.bookingId)}`, {
    idempotency_key: `update:${opts.bookingId}:${opts.version}`,
    booking: {
      version: opts.version,
      start_at: opts.startAtIso,
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
}
