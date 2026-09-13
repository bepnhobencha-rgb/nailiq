import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { cleanupTestSalon } from "./helpers/db";
import { seedReceptionistCenterFixture, supabaseAdmin as db } from "./receptionist-center/helpers";

const origin = "https://nailiq-p0-signup-qa-20260911.vercel.app";
const qa = "https://osdqutwunokiielbairj.supabase.co";
const evidence = process.env.NAILIQ_QA_ARTIFACT_DIR!;
if (process.env.PLAYWRIGHT_BASE_URL !== origin || process.env.NEXT_PUBLIC_SUPABASE_URL !== qa
  || process.env.SUPABASE_INTERNAL_URL !== qa || process.env.DEMO_OTP !== "false"
  || process.env.NAILIQ_CARD_SAVE_DISPATCH_DISABLED !== "true"
  || ["DISABLE_OUTBOUND_SMS", "DISABLE_OUTBOUND_EMAIL", "DISABLE_OUTBOUND_CALLS"].some(k => process.env[k] !== "1")) {
  throw new Error("Card mutation tests require pinned disposable QA with capture and outbound OFF");
}
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== qa) throw new Error("Non-QA database transport blocked");
  return nativeFetch(input, { ...init, redirect: "error" });
};
const access = readFileSync(process.env.NAILIQ_QA_PREVIEW_ACCESS_FILE!, "utf8").trim();
if (new URL(access).origin !== origin) throw new Error("Wrong Preview access origin");
type Fixture = Awaited<ReturnType<typeof seedReceptionistCenterFixture>>;
const fixtures: Fixture[] = [];
let http: APIRequestContext;
function receipt(status: string) {
  const value = { status, salons: fixtures.map(f => ({ id: f.salonId, slug: f.slug })), bookings: fixtures.map(f => f.displayApptBookingId) };
  appendFileSync(`${evidence}/fixture-history.jsonl`, JSON.stringify(value) + "\n");
  writeFileSync(`${evidence}/fixture-ids.json`, JSON.stringify(value, null, 2));
}
async function mint(action = "card_manage", f = fixtures[0]) {
  const result = await db.rpc("mint_booking_management_capability", { p_salon_id: f.salonId,
    p_booking_id: f.displayApptBookingId, p_action: action, p_min_expires_at: new Date(Date.now() + 600_000).toISOString() });
  expect(result.error).toBeNull(); expect(result.data?.ok).toBe(true);
  return result.data.token_id as string;
}
const paths = ["square-save-card", "stripe-setup-intent", "remove-card"] as const;
function body(token: string = randomUUID()) { return { token, requestId: randomUUID(), provider: "square", sourceId: "synthetic-never-dispatched", consent: true, expectedCardFingerprint: "a".repeat(64) }; }
async function post(path: string, data: unknown, originHeader: string | null = origin, extras: Record<string, string> = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...extras };
  if (originHeader !== null) headers.Origin = originHeader;
  const r = await http.post(`/api/booking/${path}`, { headers, data: JSON.stringify(data), maxRedirects: 0 });
  const value = await r.json();
  if (path !== "flag-noshow-card") expect(r.headers()["cache-control"]).toContain("no-store");
  return { status: r.status(), body: value };
}
async function assertNoCardMutation() {
  for (const f of fixtures) {
    const r = await db.from("bookings").select("status,noshow_card_id,noshow_customer_id,noshow_consent_at,noshow_card_required").eq("id", f.displayApptBookingId).single();
    expect(r.error).toBeNull();
    expect(r.data).toEqual({ status: "confirmed", noshow_card_id: null, noshow_customer_id: null, noshow_consent_at: null, noshow_card_required: true });
    for (const table of ["booking_card_save_operations", "booking_card_management_operations", "booking_management_action_receipts"]) {
      const rows = await db.from(table).select("id").eq("booking_id", f.displayApptBookingId);
      expect(rows.error).toBeNull(); expect(rows.data).toEqual([]);
    }
  }
}
test.beforeAll(async () => {
  for (const suffix of ["a", "b"]) {
    fixtures.push(await seedReceptionistCenterFixture(`e2e-p003-cardmutation-${suffix}-${randomUUID()}`)); receipt("seeding");
    const f = fixtures.at(-1)!;
    const start = Date.now() + 14 * 86400_000;
    expect((await db.from("bookings").update({ status: "confirmed", noshow_card_required: true,
      start_time_utc: new Date(start).toISOString(), end_time_utc: new Date(start + 3600_000).toISOString(),
      noshow_fee_cents: suffix === "a" ? 2500 : 7900 }).eq("id", f.displayApptBookingId).eq("salon_id", f.salonId)).error).toBeNull();
    expect((await db.from("salons").update({ name: `QA Card Mutation ${suffix.toUpperCase()}`, currency_code: "CAD" }).eq("id", f.salonId)).error).toBeNull();
  }
  http = await request.newContext({ baseURL: origin });
  await http.get(access);
  receipt("ready");
});
test.afterAll(async () => {
  await http?.dispose();
  for (const f of fixtures) await cleanupTestSalon(f.slug, { clearAllRateLimits: false });
  receipt("cleaned");
});


test("card mutations require the expected browser origin before body or dispatch", async () => {
  for (const path of paths) {
    for (const header of [null, "null", "https://foreign.example.test"]) {
      expect(await post(path, body(), header)).toEqual({ status: 403, body: { ok: false, code: "forbidden" } });
    }
    expect(await post(path, body(), origin, { "Sec-Fetch-Site": "cross-site" })).toEqual({ status: 403, body: { ok: false, code: "forbidden" } });
  }
  await assertNoCardMutation();
});
test("malformed and oversized requests are rejected before release gates", async () => {
  for (const path of paths) {
    for (const payload of [null, [], {}, { bookingId: fixtures[0].displayApptBookingId }, { ...body(), padding: "x".repeat(5000) }]) {
      expect(await post(path, payload)).toEqual({ status: 400, body: { ok: false, code: "invalid_request" } });
    }
  }
  await assertNoCardMutation();
});
test("remove rejects naked IDs, foreign scopes, expired and revoked tokens", async () => {
  for (const token of [randomUUID(), fixtures[0].displayApptBookingId, await mint("cancel"), await mint("status")]) {
    const r = await post("remove-card", body(token));
    expect(r.status).toBe(404); expect(r.body).toMatchObject({ ok: false, code: "invalid_token" });
  }
  for (const patch of [{ expires_at: new Date(Date.now() - 1000).toISOString() }, { revoked_at: new Date().toISOString(), revoke_reason: "manual_revoke" }]) {
    const token = await mint();
    expect((await db.from("booking_management_capabilities").update(patch).eq("id", token)).error).toBeNull();
    const r = await post("remove-card", body(token));
    expect(r.status).toBe(404); expect(r.body).toMatchObject({ ok: false, code: "expired_or_revoked" });
  }
  await assertNoCardMutation();
});
test("stale card fingerprint and simultaneous unauthorized retries create no operation", async () => {
  const token = await mint();
  const r = await post("remove-card", { ...body(token), salonId: fixtures[1].salonId, bookingId: fixtures[1].displayApptBookingId });
  expect(r.status).toBe(409); expect(r.body).toMatchObject({ ok: false, code: "stale_card" });
  const payload = body(randomUUID());
  const repeated = await Promise.all(Array.from({ length: 4 }, () => post("remove-card", payload)));
  for (const response of repeated) { expect(response.status).toBe(404); expect(response.body.ok).toBe(false); }
  await assertNoCardMutation();
});
test("save and setup database claims enforce action scope without relying on the application pause", async () => {
  const token = await mint("cancel");
  for (const [provider, mode] of [["square", "save_card"], ["stripe", "save_card"], ["stripe", "setup_intent"]]) {
    const r = await db.rpc("claim_booking_card_save_operation", { p_token_id: token, p_request_id: randomUUID(), p_provider: provider, p_mode: mode, p_source_fingerprint: "b".repeat(64) });
    expect(r.error).toBeNull(); expect(r.data).toMatchObject({ ok: false, code: "invalid_token" });
  }
  await assertNoCardMutation();
});
test("retired flag route and paused save cannot mutate a reserved booking", async () => {
  const token = await mint();
  const flag = await post("flag-noshow-card", body(token));
  expect(flag).toEqual({ status: 410, body: { ok: false, code: "route_retired" } });
  const save = await post("square-save-card", body(token));
  expect(save.status).toBe(503); expect(save.body).toMatchObject({ ok: false, code: "card_capture_paused" });
  const setup = await post("stripe-setup-intent", body(token));
  expect(setup.status).toBe(503); expect(setup.body).toMatchObject({ ok: false, code: "phase_2_not_available" });
  await assertNoCardMutation();
});
test("concurrent removal of an already-empty card creates one receipt and stays tenant-bound", async () => {
  await assertNoCardMutation();
  const token = await mint();
  const info = await http.get(`/api/booking/card-info?token=${token}`);
  expect(info.status()).toBe(200);
  const card = await info.json(); expect(card.hasCard).toBe(false);
  const payload = { ...body(token), expectedCardFingerprint: card.cardFingerprint,
    bookingId: fixtures[1].displayApptBookingId, salonId: fixtures[1].salonId };
  const responses = await Promise.all(Array.from({ length: 4 }, () => post("remove-card", payload)));
  writeFileSync(`${evidence}/empty-removal-http.json`, JSON.stringify(responses.map(r => ({ status: r.status, code: r.body.code, idempotent: r.body.idempotent })), null, 2));
  if (responses.some(r => r.status !== 200)) {
    const diagnostic = await db.rpc("claim_booking_card_management_operation", { p_token_id: token, p_request_id: payload.requestId, p_expected_card_fingerprint: card.cardFingerprint });
    writeFileSync(`${evidence}/empty-removal-db.private.json`, JSON.stringify(diagnostic, null, 2), { mode: 0o600 });
  }
  for (const r of responses) {
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, code: "already_removed", bookingId: fixtures[0].displayApptBookingId, salonId: fixtures[0].salonId });
  }
  expect(responses.filter(r => r.body.idempotent === false)).toHaveLength(1);
  expect(responses.filter(r => r.body.idempotent === true)).toHaveLength(3);
  const operation = await db.from("booking_card_management_operations").select("id,provider_material,provider_reference,result_json,error_code,status")
    .eq("booking_id", fixtures[0].displayApptBookingId).single();
  expect(operation.error).toBeNull();
  expect(operation.data).toMatchObject({ provider_material: {}, provider_reference: null, error_code: null, status: "succeeded" });
  const original = operation.data!;
  const result = original.result_json as Record<string, unknown>;
  for (const patch of [
    { provider_material: { card_id: "synthetic-not-a-noop" } },
    { result_json: { ...result, code: "removed" } },
    { result_json: { ...result, ok: false } },
    { result_json: { ...result, booking_id: null } },
    { result_json: { ...result, salon_id: fixtures[1].salonId } },
    { result_json: { ...result, idempotent: true } },
    { error_code: "synthetic_error" },
  ]) {
    const rejected = await db.from("booking_card_management_operations").update(patch).eq("id", original.id);
    expect(rejected.error?.code).toBe("23514");
  }
  const unchanged = await db.from("booking_card_management_operations").select("id,provider_material,provider_reference,result_json,error_code,status").eq("id", original.id).single();
  expect(unchanged.error).toBeNull(); expect(unchanged.data).toEqual(original);
  const changedRequest = await post("remove-card", { ...payload, requestId: randomUUID() });
  expect(changedRequest.status).toBe(409); expect(changedRequest.body).toMatchObject({ ok: false, code: "idempotency_mismatch" });
  for (const [index, f] of fixtures.entries()) {
    const booking = await db.from("bookings").select("status,noshow_card_id,noshow_customer_id,noshow_consent_at,noshow_card_required").eq("id", f.displayApptBookingId).single();
    expect(booking.error).toBeNull();
    expect(booking.data).toEqual({ status: "confirmed", noshow_card_id: null, noshow_customer_id: null, noshow_consent_at: null, noshow_card_required: true });
    for (const table of ["booking_card_save_operations", "booking_card_management_operations", "booking_management_action_receipts"]) {
      const rows = await db.from(table).select("id").eq("booking_id", f.displayApptBookingId);
      expect(rows.error).toBeNull(); expect(rows.data).toHaveLength(index === 0 && table !== "booking_card_save_operations" ? 1 : 0);
    }
  }
});
