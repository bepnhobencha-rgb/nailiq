/** Card-only Sandbox certification guard. Importing this module does no I/O.
 * Every provider request is pinned to Sandbox. No charge, refund, messaging,
 * webhook mutation, production DB or arbitrary card source can pass. */
import type { SquareConfig } from "../src/shared/integrations/square/client";

const SANDBOX = "https://connect.squareupsandbox.com";
const LOCAL_QA = "http://127.0.0.1:55631";
const REFERENCE = /^nq-card:[0-9a-f-]{36}$/i;
const CUSTOMER_REFERENCE = /^(?:nq-customer|booking):[0-9a-f-]{36}$/i;
const SYNTHETIC_EMAIL = /^synthetic-[a-z0-9-]+@example\.com$/;
const SANDBOX_SOURCES = new Set(["cnon:card-nonce-ok", "cnon:card-nonce-declined"]);
type Env = Record<string, string | undefined>;
export type CardSandboxNotificationMode = "off_required" | "test_notifications_authorized";
export type CardSandboxConfig = { square: SquareConfig; webhookAccessToken: string; databaseUrl: string; supabaseUrl: string; serviceRoleKey: string; notificationMode: CardSandboxNotificationMode };
export type CardSandboxMode = "success" | "before_dispatch" | "response_loss" | "db_before" | "db_after";
export type CardSandboxCounts = { customerCreates: number; cardCreates: number; cardReads: number; responseLossInjected: boolean; databaseLossInjected: boolean };
const stop = (code: string): never => { throw new Error(code); };
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function readCardSandboxConfig(env: Env): CardSandboxConfig {
  if (env.NAILIQ_CARD_SANDBOX_QA !== "1") stop("sandbox_card_test_not_enabled");
  if ([env.DISABLE_OUTBOUND_SMS, env.DISABLE_OUTBOUND_EMAIL, env.DISABLE_OUTBOUND_CALLS].some(value => value !== "1")) stop("outbound_must_be_disabled");
  const notificationMode = env.NAILIQ_QA_SQUARE_NOTIFICATION_MODE ?? "off_required";
  if (notificationMode !== "off_required" && notificationMode !== "test_notifications_authorized") return stop("sandbox_notification_mode_invalid");
  // This attests separately recorded provider evidence; webhook reads alone
  // cannot prove customer/merchant email or SMS suppression. The explicit
  // authorization mode accepts those test notifications, not arbitrary sends.
  if (notificationMode === "off_required" && env.NAILIQ_QA_SQUARE_NOTIFICATIONS_OFF_VERIFIED !== "1") stop("sandbox_notifications_off_unproven");
  if (env.NAILIQ_QA_SQUARE_ENVIRONMENT !== "sandbox") stop("sandbox_environment_required");
  if (env.NEXT_PUBLIC_SUPABASE_URL !== LOCAL_QA) stop("disposable_loopback_qa_required");
  let database: URL;
  try { database = new URL(env.DB_URL ?? ""); } catch { return stop("disposable_loopback_qa_required"); }
  if (database.protocol !== "postgresql:" || database.hostname !== "127.0.0.1" || database.port !== "55632" || database.pathname !== "/postgres" || database.username !== "postgres" || database.search || database.hash) stop("disposable_loopback_qa_required");
  const applicationId = env.NAILIQ_QA_SQUARE_SANDBOX_APPLICATION_ID ?? "";
  const merchantId = env.NAILIQ_QA_SQUARE_SANDBOX_MERCHANT_ID ?? "";
  const locationId = env.NAILIQ_QA_SQUARE_SANDBOX_LOCATION_ID ?? "";
  const accessToken = env.NAILIQ_QA_SQUARE_SANDBOX_ACCESS_TOKEN ?? "";
  const webhookAccessToken = env.NAILIQ_QA_SQUARE_SANDBOX_WEBHOOK_ACCESS_TOKEN ?? accessToken;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!/^sandbox-sq0idb-[A-Za-z0-9_-]{8,}$/.test(applicationId) || !/^[A-Za-z0-9_-]{8,255}$/.test(merchantId) ||
      !/^[A-Za-z0-9_-]{8,255}$/.test(locationId) || accessToken.length < 20 || webhookAccessToken.length < 20 || serviceRoleKey.length < 20) stop("sandbox_configuration_missing");
  return { databaseUrl: database.href, supabaseUrl: LOCAL_QA, serviceRoleKey, webhookAccessToken, notificationMode,
    square: { salonId: "55630000-0000-4000-8000-000000000060", applicationId, merchantId, locationId, accessToken,
      environment: "sandbox", currency: "CAD", sync: { pullCreate:false, pullUpdate:false, pullCancel:false, pushCreate:false, pushUpdate:false, pushCancel:false } } };
}

export function createCardSandboxGuard(config: CardSandboxConfig, nativeFetch: typeof fetch) {
  let armed = false;
  let mode: CardSandboxMode = "success";
  let counts: CardSandboxCounts = { customerCreates:0, cardCreates:0, cardReads:0, responseLossInjected:false, databaseLossInjected:false };
  let totalWrites = 0;
  const publicCounts = () => ({ ...counts });
  const headers = { Authorization:`Bearer ${config.square.accessToken}`, "Square-Version":"2024-12-18", "Content-Type":"application/json" };
  const webhookHeaders = { ...headers, Authorization:`Bearer ${config.webhookAccessToken}` };

  async function readPreflight(path: string, method = "GET", requestHeaders = headers): Promise<Record<string, unknown>> {
    try {
      const response = await nativeFetch(SANDBOX + path, { method, headers:requestHeaders, redirect:"error", cache:"no-store", signal:AbortSignal.timeout(12_000) });
      const value: unknown = await response.json();
      if (!response.ok || !object(value) || object(value)?.errors) stop("sandbox_preflight_failed");
      return value as Record<string, unknown>;
    } catch { return stop("sandbox_preflight_failed"); }
  }

  async function preflight() {
    armed = false;
    const token = await readPreflight("/oauth2/token/status", "POST");
    if (token.client_id !== config.square.applicationId || token.merchant_id !== config.square.merchantId) stop("sandbox_identity_mismatch");
    const locations = await readPreflight("/v2/locations");
    if (!Array.isArray(locations.locations) || !locations.locations.some(value => {
      const location = object(value);
      return location?.id === config.square.locationId && location.merchant_id === config.square.merchantId && location.currency === config.square.currency && location.status === "ACTIVE";
    })) stop("sandbox_location_mismatch");
    // Seller calls use the test account's token. Webhooks belong to the app
    // and require its personal token, which may belong to the default seller.
    // Prove the same Sandbox app before using that token for read-only checks.
    if (config.webhookAccessToken !== config.square.accessToken) {
      const webhookToken = await readPreflight("/oauth2/token/status", "POST", webhookHeaders);
      if (webhookToken.client_id !== config.square.applicationId) stop("sandbox_webhook_identity_mismatch");
    }
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page = await readPreflight("/v2/webhooks/subscriptions" + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""), "GET", webhookHeaders);
      const subscriptions = page.subscriptions === undefined ? [] : page.subscriptions;
      if (!Array.isArray(subscriptions) || subscriptions.some(value => object(value)?.enabled !== false)) stop("sandbox_webhooks_not_disabled");
      if (page.cursor != null && typeof page.cursor !== "string") stop("sandbox_webhooks_unproven");
      cursor = typeof page.cursor === "string" && page.cursor ? page.cursor : null;
      if (cursor && (seen.has(cursor) || seen.size >= 50)) stop("sandbox_webhooks_unproven");
      if (cursor) seen.add(cursor);
    } while (cursor);
    armed = true;
  }

  const guardedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === LOCAL_QA) {
      if (!armed) stop("sandbox_preflight_required");
      if (url.pathname.endsWith("/rpc/complete_booking_card_save_operation") && !counts.databaseLossInjected && (mode === "db_before" || mode === "db_after")) {
        counts.databaseLossInjected = true;
        if (mode === "db_after") await nativeFetch(request);
        throw new Error("qa_database_response_loss");
      }
      return nativeFetch(request);
    }
    if (url.origin !== SANDBOX || url.username || url.password) stop("sandbox_network_boundary_denied");
    if (!armed) stop("sandbox_preflight_required");
    const method = request.method;
    const search = method === "POST" && url.pathname === "/v2/customers/search" && !url.search;
    const customer = method === "POST" && url.pathname === "/v2/customers" && !url.search;
    const createCard = method === "POST" && url.pathname === "/v2/cards" && !url.search;
    const readCard = method === "GET" && url.pathname === "/v2/cards" && REFERENCE.test(url.searchParams.get("reference_id") ?? "");
    if (!search && !customer && !createCard && !readCard) stop("card_only_route_denied");
    if (request.headers.get("Authorization") !== headers.Authorization) stop("sandbox_token_mismatch");
    let body: Record<string, unknown> | null = null;
    if (method === "POST") {
      try { body = object(await request.clone().json()); } catch { stop("synthetic_body_required"); }
      if (!body) stop("synthetic_body_required");
    }
    if (search) {
      const filter = object(object(body?.query)?.filter);
      const keys = Object.keys(filter ?? {});
      const exact = keys.length === 1 ? object(filter?.[keys[0]])?.exact : null;
      if (typeof exact !== "string" || !(
        (keys[0] === "phone_number" && /^\+1\d{3}555\d{4}$/.test(exact)) ||
        (keys[0] === "reference_id" && CUSTOMER_REFERENCE.test(exact)) ||
        (keys[0] === "email_address" && SYNTHETIC_EMAIL.test(exact))
      )) stop("synthetic_search_required");
    }
    if (customer) {
      if (!String(body?.given_name ?? "").startsWith("Synthetic") ||
          !CUSTOMER_REFERENCE.test(String(body?.reference_id ?? "")) ||
          (body?.phone_number != null && !/^\+1\d{3}555\d{4}$/.test(String(body.phone_number))) ||
          (body?.email_address != null && !SYNTHETIC_EMAIL.test(String(body.email_address)))) stop("synthetic_customer_required");
    }
    if (mode === "before_dispatch" && search) throw new Error("qa_customer_read_timeout");
    let outgoing = request;
    if (createCard) {
      const card = object(body?.card);
      if (!SANDBOX_SOURCES.has(String(body?.source_id)) || !REFERENCE.test(String(card?.reference_id ?? "")) ||
          Object.keys(card ?? {}).some(key => !["customer_id","reference_id"].includes(key)) ||
          Object.keys(body ?? {}).some(key => !["idempotency_key","source_id","card"].includes(key))) stop("sandbox_fixed_source_required");
      // Documented fixture requirement for fixed nonces only. This adjustment
      // is test transport data, not a production adapter behavior or SDK proof.
      outgoing = new Request(request.url, { method, headers:request.headers,
        body:JSON.stringify({ ...body, card:{ ...card, billing_address:{postal_code:"94103"} } }), signal:request.signal, redirect:"error" });
      counts.cardCreates += 1;
    }
    if (customer) counts.customerCreates += 1;
    if (customer || createCard) { totalWrites += 1; if (totalWrites > 24) stop("sandbox_write_budget_exceeded"); }
    if (readCard) counts.cardReads += 1;
    const result = await nativeFetch(outgoing, { redirect:"error" });
    if (createCard && mode === "response_loss" && result.ok && !counts.responseLossInjected) {
      counts.responseLossInjected = true;
      await result.arrayBuffer();
      throw new Error("qa_provider_response_loss");
    }
    return result;
  };
  return { fetch:guardedFetch, preflight, counts:publicCounts,
    setMode(value: CardSandboxMode) { mode = value; counts = { customerCreates:0,cardCreates:0,cardReads:0,responseLossInjected:false,databaseLossInjected:false }; } };
}
