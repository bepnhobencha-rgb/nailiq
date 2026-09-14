import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// Opt-in only. Real TypeScript coordinator + real PostgreSQL RPCs; Square HTTP
// is simulated and never forwarded. This is NOT a Square Sandbox claim.
vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/shared/integrations/payments", () => ({ resolvePaymentProvider: async (salonId: string) => {
  const { SquareProvider } = await import("@/shared/integrations/payments/square");
  return new SquareProvider(configFor(salonId));
} }));
vi.mock("@/shared/integrations/square/client", async (original) => ({
  ...await original<typeof import("@/shared/integrations/square/client")>(),
  getSquareConfig: async (_db: unknown, salonId: string) => configFor(salonId),
}));

import { saveCardWithManagementCapability } from "../bookingCardManagement";
import { reconcileBookingCardSaveOperations } from "../reconcileBookingCardSaveOperations";
import type { SquareConfig } from "@/shared/integrations/square/client";

const enabled = process.env.NAILIQ_SQUARE_CUSTOMER_AUTHORITY_QA === "1";
const socket = "unix:///Users/huytran/.colima/default/docker.sock";
const container = "nailiq-b01-rehearsal-db-20260912";
const database = "r10_integration_20260913";
const sqlArgs = ["--host", socket, "exec", "-i", container, "psql", "-U", "postgres", "-d", database,
  "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=sqlstate"];
const allowedRpcs = [
  "mint_booking_management_capability", "recover_booking_card_management", "claim_booking_card_save_operation",
  "prepare_booking_card_save_dispatch", "bind_booking_card_provider_identity", "bind_booking_card_save_dispatch",
  "claim_square_card_customer", "prepare_square_card_customer", "complete_square_card_customer",
  "complete_booking_card_save_operation", "record_booking_card_delivery_failure",
  "claim_booking_card_save_reconciliation", "complete_booking_card_save_reconciliation",
] as const;
const allowedTypes = new Set(["uuid", "text", "boolean", "integer", "timestamp with time zone", "jsonb", "text[]"]);
const signatures = new Map<string, Record<string, string>>();
const sqlErrors: { rpc: string; code: string }[] = [];
let guardReady = false;

function literal(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function sql(query: string): Promise<string> {
  if (!enabled || !guardReady) throw new Error("exact_disposable_qa_only");
  return new Promise((resolve, reject) => {
    const child = execFile("docker", sqlArgs, { encoding: "utf8", timeout: 20_000, maxBuffer: 1_000_000 }, (error, stdout, stderr) => {
      if (error) {
        // SQLSTATE only: never return the SQL text or provider/customer material.
        const code = /ERROR:\s+([0-9A-Z]{5})/.exec(stderr)?.[1] ?? "QA_SQL_FAILED";
        reject(new Error(code));
      } else resolve(stdout.trim());
    });
    child.stdin?.end(`SET standard_conforming_strings=on;\n${query}`);
  });
}
function argument(value: unknown, type: string): string {
  if (!allowedTypes.has(type)) throw new Error("rpc_type_not_allowlisted");
  if (value === null) return `NULL::${type}`;
  if (type === "jsonb") return `${literal(JSON.stringify(value))}::jsonb`;
  if (type === "text[]" && Array.isArray(value) && value.every(item => typeof item === "string")) {
    return `ARRAY[${value.map(literal).join(",")}]::text[]`;
  }
  if (type === "boolean" && typeof value === "boolean") return `${value}::boolean`;
  if (type === "integer" && typeof value === "number" && Number.isSafeInteger(value)) return `${value}::integer`;
  if (["uuid", "text", "timestamp with time zone"].includes(type) && typeof value === "string") return `${literal(value)}::${type}`;
  throw new Error("rpc_argument_type_mismatch");
}
const db = {
  async rpc(name: string, args: Record<string, unknown>) {
    if (!allowedRpcs.includes(name as typeof allowedRpcs[number])) throw new Error("rpc_not_allowlisted");
    const definition = signatures.get(name);
    if (!definition) throw new Error("rpc_signature_not_loaded");
    const named = Object.entries(args).map(([key, value]) => {
      if (!/^p_[a-z][a-z0-9_]*$/.test(key) || !definition[key]) throw new Error("rpc_argument_not_allowlisted");
      return `${key}=>${argument(value, definition[key])}`;
    });
    try {
      const value = await sql(`BEGIN; SET LOCAL ROLE service_role;
        SET LOCAL request.jwt.claim.role='service_role'; SET LOCAL request.jwt.claims='{"role":"service_role"}';
        SELECT to_jsonb(public.${name}(${named.join(",")})); COMMIT;`);
      return { data: JSON.parse(value) as Record<string, unknown>, error: null };
    } catch (error) {
      const code = error instanceof Error ? error.message : "QA_SQL_FAILED";
      sqlErrors.push({ rpc: name, code });
      return { data: null, error: { code, message: "disposable_rpc_failed" } };
    }
  },
  from() { throw new Error("unexpected_query_builder_access"); },
};
async function rpc(name: string, args: Record<string, unknown>) {
  const response = await db.rpc(name, args);
  expect(response.error, `RPC ${name}`).toBeNull();
  expect(response.data).not.toBeNull();
  return response.data!;
}

type Tenant = { salon: string; service: string; staff: string; cfg: SquareConfig };
const tenants: Tenant[] = [0, 1].map(index => {
  const salon = randomUUID();
  return { salon, service: randomUUID(), staff: randomUUID(), cfg: {
    salonId: salon, merchantId: `merchant_r10_${index}`, locationId: `location_r10_${index}`,
    applicationId: "sandbox-synthetic-r10", environment: "sandbox", currency: "CAD", accessToken: `SYNTHETIC_R10_${index}`,
    sync: { pullCreate: false, pullUpdate: false, pullCancel: false, pushCreate: false, pushUpdate: false, pushCancel: false },
  } };
});
let configOverride: Partial<SquareConfig> | null = null;
function configFor(salonId: string): SquareConfig {
  const tenant = tenants.find(item => item.salon === salonId);
  if (!tenant) throw new Error("synthetic_salon_only");
  return { ...tenant.cfg, ...configOverride };
}
type Channel = "sms" | "email" | "staff_attested" | "demo" | "legacy_unverified";
type Fixture = { booking: string; tokenId: string; requestId: string; provider: "square"; sourceToken: string };
type Operation = { id: string; attempt_token: string; status: string; customer_claim_id: string; expected_customer_id: string | null;
  provider_material: Record<string, unknown> };
let sequence = 0;
async function fixture(options: { tenant?: Tenant; phone?: string; email?: string; channel?: Channel; invalidBinding?: boolean } = {}): Promise<Fixture> {
  const tenant = options.tenant ?? tenants[0];
  const booking = randomUUID();
  sequence += 1;
  const phone = options.phone ?? `+1604555${String(1000 + sequence).padStart(4, "0")}`;
  await sql(`INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,client_email,
    start_time_utc,end_time_utc,status,price_cents,noshow_card_required,noshow_fee_cents)
    VALUES(${literal(booking)},${literal(tenant.salon)},${literal(tenant.service)},${literal(tenant.staff)},'Synthetic QA Guest',
      ${literal(phone)},${literal(options.email ?? "synthetic@example.test")},
      date_trunc('hour',now())+interval '4 days'+interval '${sequence} hours',
      date_trunc('hour',now())+interval '4 days'+interval '${sequence} hours 30 minutes','confirmed',5000,true,1000);`);
  if (options.channel) {
    const session = randomUUID();
    const consumedBy = options.invalidBinding ? (await fixture()).booking : booking;
    await sql(`INSERT INTO public.phone_otp_sessions(id,phone,salon_id,verified_channel,verified_at,expires_at,consumed_at,consumed_by_booking_id)
      VALUES(${literal(session)},${literal(phone)},${literal(tenant.salon)},${literal(options.channel)},
        now()-interval '4 minutes',now()+interval '10 minutes',now()-interval '3 minutes',${literal(consumedBy)});
      UPDATE public.bookings SET otp_session_id=${literal(session)} WHERE id=${literal(booking)};`);
  }
  const cap = await rpc("mint_booking_management_capability", { p_salon_id: tenant.salon, p_booking_id: booking,
    p_action: "card_manage", p_min_expires_at: new Date(Date.now() + 25 * 60_000).toISOString() });
  expect(cap.ok).toBe(true);
  return { booking, tokenId: cap.token_id as string, requestId: randomUUID(), provider: "square", sourceToken: "SYNTHETIC_CARD_SOURCE" };
}
async function operation(booking: string): Promise<Operation> {
  return JSON.parse(await sql(`SELECT to_jsonb(o) FROM public.booking_card_save_operations o WHERE booking_id=${literal(booking)} ORDER BY created_at DESC,delivery_sequence DESC LIMIT 1;`)) as Operation;
}
async function bookingState(booking: string) {
  return JSON.parse(await sql(`SELECT jsonb_build_object('status',status,'protection',card_protection_status,
    'card',noshow_card_id,'customer',noshow_customer_id,'brand',noshow_card_brand,'last4',noshow_card_last4,
    'consent',noshow_consent_at,'policy',noshow_consent_meta->>'policyVersion') FROM public.bookings WHERE id=${literal(booking)};`)) as Record<string, unknown>;
}
async function retry(input: Fixture): Promise<Fixture> {
  const recovered = await rpc("recover_booking_card_management", { p_token_id: input.tokenId });
  expect(recovered.ok).toBe(true);
  return { ...input, tokenId: recovered.token_id as string, requestId: randomUUID(), sourceToken: "SYNTHETIC_FRESH_CARD_SOURCE" };
}
async function due(id: string) {
  await sql(`UPDATE public.booking_card_save_operations SET created_at=now()-interval '21 minutes',
    consent_at=now()-interval '20 minutes',dispatch_prepared_at=now()-interval '20 minutes',
    next_reconcile_at=now()-interval '1 minute',reconciliation_lease_expires_at=NULL WHERE id=${literal(id)};`);
}

type Customer = { id: string; reference_id?: string; phone_number?: string; email_address?: string; merchant: string };
type Card = { id: string; customer_id: string; merchant_id: string; reference_id: string; enabled: boolean; card_brand: string; last_4: string };
type Call = { method: string; path: string; body: Record<string, unknown> };
function transport() {
  const calls: Call[] = [];
  const customers: Customer[] = [];
  const cards: Card[] = [];
  const mode = { decline: false, customerLoss: false, cardLoss: false };
  let serial = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(address);
    if (url.origin !== "https://connect.squareupsandbox.com") throw new Error("external_network_denied");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ method, path: url.pathname + url.search, body });
    const token = new Headers(init?.headers).get("authorization");
    const merchant = tenants.find(item => token === `Bearer ${item.cfg.accessToken}`)?.cfg.merchantId;
    if (!merchant) throw new Error("synthetic_provider_account_only");
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url.pathname === "/v2/customers/search" && method === "POST") {
      const filter = (body.query as { filter?: Record<string, { exact: string }> })?.filter;
      if (!filter || Object.keys(filter).length !== 1) throw new Error("unexpected_customer_query");
      const [field, expected] = Object.entries(filter)[0];
      if (!["reference_id", "phone_number", "email_address"].includes(field)) throw new Error("unexpected_customer_filter");
      return response({ customers: customers.filter(customer => customer.merchant === merchant
        && customer[field as "reference_id" | "phone_number" | "email_address"] === expected.exact) });
    }
    if (url.pathname === "/v2/customers" && method === "POST") {
      const customer: Customer = { id: `customer_r10_${++serial}`, merchant,
        reference_id: body.reference_id as string, phone_number: body.phone_number as string | undefined,
        email_address: body.email_address as string | undefined };
      customers.push(customer);
      if (mode.customerLoss) { mode.customerLoss = false; throw new TypeError("SYNTHETIC_CUSTOMER_RESPONSE_LOST"); }
      return response({ customer });
    }
    if (url.pathname.startsWith("/v2/customers/") && method === "GET") {
      const customer = customers.find(item => item.merchant === merchant && item.id === url.pathname.split("/").at(-1));
      return customer ? response({ customer }) : response({ errors: [{ code: "NOT_FOUND", category: "INVALID_REQUEST_ERROR" }] }, 404);
    }
    if (url.pathname === "/v2/cards" && method === "POST") {
      if (mode.decline) return response({ errors: [{ category: "PAYMENT_METHOD_ERROR", code: "CARD_DECLINED" }] }, 400);
      const material = body.card as { customer_id: string; reference_id: string };
      const card: Card = { id: `card_r10_${++serial}`, customer_id: material.customer_id,
        merchant_id: merchant, reference_id: material.reference_id, enabled: true, card_brand: "VISA", last_4: "4242" };
      cards.push(card);
      if (mode.cardLoss) { mode.cardLoss = false; throw new TypeError("SYNTHETIC_CARD_RESPONSE_LOST"); }
      return response({ card });
    }
    if (url.pathname === "/v2/cards" && method === "GET" && url.searchParams.has("reference_id")) {
      return response({ cards: cards.filter(card => card.merchant_id === merchant && card.reference_id === url.searchParams.get("reference_id")) });
    }
    throw new Error("unapproved_provider_route_no_payments_or_outbound");
  });
  return { calls, customers, cards, mode,
    creates: (kind: "customers" | "cards") => calls.filter(call => call.method === "POST" && call.path === `/v2/${kind}`),
    searches: () => calls.filter(call => call.path === "/v2/customers/search") };
}

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); configOverride = null; });
describe.skipIf(!enabled)("R10 real PostgreSQL + card coordinator + simulated Square identity authority", () => {
  beforeAll(async () => {
    const state = execFileSync("docker", ["--host", socket, "inspect", container,
      "--format", "{{.HostConfig.NetworkMode}}|{{.State.Running}}"], { encoding: "utf8" }).trim();
    expect(state).toBe("none|true");
    guardReady = true;
    expect(await sql("SELECT current_database()||'|'||current_setting('cron.launch_active_jobs',true)||'|'||(to_regclass('cron.job') IS NULL);"))
      .toBe(`${database}|off|true`);
    expect(await sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='square_card_customer_claims' AND column_name='identity_version';")).toBe("1");
    const rows = JSON.parse(await sql(`SELECT jsonb_agg(jsonb_build_object('name',p.proname,'args',
      (SELECT jsonb_object_agg(p.proargnames[i],format_type(p.proargtypes[i-1],NULL)) FROM generate_series(1,p.pronargs) i)))
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN (${allowedRpcs.map(literal).join(",")});`)) as { name: string; args: Record<string, string> }[];
    expect(rows).toHaveLength(allowedRpcs.length);
    for (const row of rows) {
      expect(Object.values(row.args).every(type => allowedTypes.has(type))).toBe(true);
      signatures.set(row.name, row.args);
    }
    await sql("INSERT INTO public.service_categories(slug,name_en,name_vi) VALUES('r10-authority-qa','Synthetic QA','Synthetic QA') ON CONFLICT DO NOTHING;");
    for (const tenant of tenants) await sql(`INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code,profile_complete,noshow_protection_enabled,cancellation_policy)
      VALUES(${literal(tenant.salon)},${literal(`r10-authority-${tenant.salon}`)},'Synthetic R10 Salon','+16045550100','America/Vancouver','CAD',true,true,
        '{"en":"Cancel with 24 hours notice.","vi":"Báo trước 24 giờ khi hủy."}');
      INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
        VALUES(${literal(tenant.service)},${literal(tenant.salon)},'Synthetic Service',5000,30,'r10-authority-qa');
      INSERT INTO public.staff(id,salon_id,name,status) VALUES(${literal(tenant.staff)},${literal(tenant.salon)},'Synthetic Staff','active');`);
  }, 60_000);

  it.each([undefined, "email", "staff_attested", "demo", "legacy_unverified"] as const)(
    "%s authority cannot reuse a victim contact or forward declared phone/email", async channel => {
      const phone = "+16045550199";
      const email = "synthetic-victim@example.test";
      const network = transport();
      network.customers.push({ id: "victim_customer", merchant: tenants[0].cfg.merchantId, phone_number: phone, email_address: email });
      const input = await fixture({ phone, email, channel });
      const result = await saveCardWithManagementCapability(input);
      expect(result.ok).toBe(true);
      const state = await bookingState(input.booking);
      expect(state).toMatchObject({ status: "confirmed", protection: "saved", brand: "VISA", last4: "4242" });
      expect(state.customer).not.toBe("victim_customer");
      expect(state.consent).toBeTruthy(); expect(state.policy).toMatch(/^nsp_[a-f0-9]{64}$/);
      expect((await operation(input.booking)).status).toBe("succeeded");
      expect(network.creates("customers")).toHaveLength(1);
      expect(network.creates("customers")[0].body).not.toHaveProperty("phone_number");
      expect(network.creates("customers")[0].body).not.toHaveProperty("email_address");
      for (const call of network.searches()) expect(Object.keys((call.body.query as { filter: object }).filter)).toEqual(["reference_id"]);
    }, 30_000);

  it("exact consumed SMS bookings for the same phone share one customer under concurrent saves", async () => {
    const network = transport();
    const first = await fixture({ phone: "+16045550201", channel: "sms" });
    const second = await fixture({ phone: "6045550201", channel: "sms" });
    const inputs = [first, second];
    const results = await Promise.all(inputs.map(input => saveCardWithManagementCapability(input)));
    for (const [index, input] of inputs.entries()) {
      if (!results[index].ok) {
        expect((await operation(input.booking)).status).toBe("failed");
        expect((await saveCardWithManagementCapability(await retry(input))).ok).toBe(true);
      }
    }
    expect((await operation(first.booking)).customer_claim_id).toBe((await operation(second.booking)).customer_claim_id);
    expect((await bookingState(first.booking)).customer).toBe((await bookingState(second.booking)).customer);
    expect(network.creates("customers")).toHaveLength(1); expect(network.creates("cards")).toHaveLength(2);
    expect(network.creates("customers")[0].body.phone_number).toBe("+16045550201");
    expect(network.creates("customers")[0].body).not.toHaveProperty("email_address");
  }, 30_000);

  it("eight duplicate requests for one booking create one customer, one card and one durable operation", async () => {
    const network = transport();
    const input = await fixture({ channel: "email" });
    const results = await Promise.all(Array.from({ length: 8 }, () => saveCardWithManagementCapability(input)));
    expect(results.some(result => result.ok)).toBe(true);
    expect(network.creates("customers")).toHaveLength(1);
    expect(network.creates("cards")).toHaveLength(1);
    expect(await sql(`SELECT count(*) FROM public.booking_card_save_operations WHERE booking_id=${literal(input.booking)};`)).toBe("1");
    expect((await bookingState(input.booking)).protection).toBe("saved");
  }, 30_000);

  it("SMS proof consumed by a different booking gives no phone lookup authority", async () => {
    const network = transport();
    const input = await fixture({ channel: "sms", invalidBinding: true });
    expect((await saveCardWithManagementCapability(input)).ok).toBe(true);
    expect(network.creates("customers")[0].body).not.toHaveProperty("phone_number");
    for (const call of network.searches()) expect(Object.keys((call.body.query as { filter: object }).filter)).toEqual(["reference_id"]);
  }, 30_000);

  it("a definite decline and explicit new-card retry reuse the same booking-scoped customer", async () => {
    const network = transport(); network.mode.decline = true;
    const input = await fixture({ channel: "email" });
    expect((await saveCardWithManagementCapability(input)).ok).toBe(false);
    const old = await operation(input.booking);
    expect(old.status).toBe("failed"); expect((await bookingState(input.booking)).protection).not.toBe("saved");
    network.mode.decline = false;
    const retried = await retry(input);
    expect((await saveCardWithManagementCapability(retried)).ok).toBe(true);
    expect((await operation(input.booking)).customer_claim_id).toBe(old.customer_claim_id);
    expect(network.creates("customers")).toHaveLength(1); expect(network.creates("cards")).toHaveLength(2);
    expect((await saveCardWithManagementCapability(retried)).ok).toBe(true);
    expect(network.creates("cards")).toHaveLength(2);
  }, 30_000);

  it("CreateCard response loss is reconciled by exact reference without another create", async () => {
    const network = transport(); network.mode.cardLoss = true;
    const input = await fixture();
    expect((await saveCardWithManagementCapability(input)).ok).toBe(false);
    const old = await operation(input.booking);
    expect(old.status).toBe("unknown"); expect((await bookingState(input.booking)).protection).not.toBe("saved");
    expect((await saveCardWithManagementCapability(input)).ok).toBe(false);
    expect(network.creates("cards")).toHaveLength(1);
    await due(old.id);
    expect(await reconcileBookingCardSaveOperations(1, old.id)).toMatchObject({ ok: true, reconciled: 1 });
    expect((await bookingState(input.booking)).protection).toBe("saved");
    expect((await operation(input.booking)).status).toBe("succeeded");
    expect((network.creates("cards")[0].body.card as { reference_id: string }).reference_id).toBe(`nq-card:${old.id}`);
    const cardReads = network.calls.filter(call => call.method === "GET" && call.path.startsWith("/v2/cards?"));
    expect(cardReads).toHaveLength(1);
    expect(new URL(cardReads[0].path, "https://connect.squareupsandbox.com").searchParams.get("reference_id")).toBe(`nq-card:${old.id}`);
    expect(network.creates("cards")).toHaveLength(1);
    await reconcileBookingCardSaveOperations(1, old.id);
    expect(network.creates("cards")).toHaveLength(1);
  }, 30_000);

  it("customer response loss retains the old reference and fences a concurrent same-phone booking", async () => {
    const network = transport(); network.mode.customerLoss = true;
    const first = await fixture({ phone: "+16045550202", channel: "sms" });
    const follower = await fixture({ phone: "+16045550202", channel: "sms" });
    expect((await saveCardWithManagementCapability(first)).ok).toBe(false);
    const old = await operation(first.booking); expect(old.status).toBe("unknown");
    const frozen = await sql(`SELECT reference_id||'|'||idempotency_key||'|'||request_material::text FROM public.square_card_customer_claims WHERE id=${literal(old.customer_claim_id)};`);
    expect((await saveCardWithManagementCapability(follower)).ok).toBe(false);
    expect(network.creates("customers")).toHaveLength(1); expect(network.creates("cards")).toHaveLength(0);
    await sql(`UPDATE public.square_card_customer_claims SET next_read_at=now()-interval '1 minute' WHERE id=${literal(old.customer_claim_id)};`);
    expect((await saveCardWithManagementCapability(await retry(follower))).ok).toBe(true);
    expect(await sql(`SELECT reference_id||'|'||idempotency_key||'|'||request_material::text FROM public.square_card_customer_claims WHERE id=${literal(old.customer_claim_id)};`)).toBe(frozen);
    expect(network.creates("customers")).toHaveLength(1); expect(network.creates("cards")).toHaveLength(1);
    expect((await bookingState(follower.booking)).customer).toBe(network.customers[0].id);
  }, 30_000);

  it("separate salons and merchant accounts cannot share the same-phone customer claim", async () => {
    const network = transport();
    const first = await fixture({ phone: "+16045550203", channel: "sms" });
    const other = await fixture({ phone: "+16045550203", channel: "sms", tenant: tenants[1] });
    expect((await saveCardWithManagementCapability(first)).ok).toBe(true);
    expect((await saveCardWithManagementCapability(other)).ok).toBe(true);
    expect((await operation(first.booking)).customer_claim_id).not.toBe((await operation(other.booking)).customer_claim_id);
    expect((await bookingState(first.booking)).customer).not.toBe((await bookingState(other.booking)).customer);
    expect(network.creates("customers")).toHaveLength(2);
  }, 30_000);

  it("a changed merchant on retry is rejected before any provider read or mutation", async () => {
    const network = transport(); network.mode.decline = true;
    const input = await fixture();
    expect((await saveCardWithManagementCapability(input)).ok).toBe(false);
    const priorCalls = network.calls.length;
    configOverride = { merchantId: "wrong_merchant" };
    expect((await saveCardWithManagementCapability(await retry(input))).ok).toBe(false);
    expect(network.calls).toHaveLength(priorCalls);
    expect((await bookingState(input.booking)).protection).not.toBe("saved");
  }, 30_000);

  it("a wrong salon in resolved configuration cannot dispatch customer/card requests", async () => {
    const network = transport();
    const input = await fixture();
    configOverride = { salonId: tenants[1].salon };
    expect((await saveCardWithManagementCapability(input)).ok).toBe(false);
    expect(network.calls).toHaveLength(0);
    expect((await bookingState(input.booking)).protection).not.toBe("saved");
  }, 30_000);

  it("executes every admitted RPC without SQL errors and preserves service-only customer authority", async () => {
    expect(sqlErrors).toEqual([]);
    expect(await sql("SELECT has_function_privilege('anon','public.claim_square_card_customer(uuid,uuid)','EXECUTE')||'|'||has_function_privilege('authenticated','public.claim_square_card_customer(uuid,uuid)','EXECUTE')||'|'||has_table_privilege('authenticated','public.square_card_customer_claims','SELECT');")).toBe("false|false|false");
    const events = await sql(`SELECT coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb) FROM public.booking_card_delivery_events e WHERE salon_id IN (${tenants.map(item => literal(item.salon)).join(",")});`);
    expect(events).not.toMatch(/SYNTHETIC_(?:CARD|FRESH_CARD|R10)|@example\.test|\+1604555/);
  });
});
