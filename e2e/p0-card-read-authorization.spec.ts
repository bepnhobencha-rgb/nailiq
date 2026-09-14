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
  throw new Error("Card read tests require pinned disposable QA with capture and outbound OFF");
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
const paths = ["card-info", "save-card-context"] as const;
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
async function get(path: typeof paths[number], token?: string, extras: Record<string, string> = {}) {
  const params = new URLSearchParams(extras);
  if (token !== undefined) params.set("token", token);
  const response = await http.get(`/api/booking/${path}?${params}`, { maxRedirects: 0 });
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  return { status: response.status(), body: await response.json() };
}
async function denied(token: string | undefined, status: number) {
  for (const path of paths) {
    const r = await get(path, token);
    expect(r.status, path).toBe(status);
    expect(r.body.ok).toBe(false);
    expect(Object.keys(r.body).sort()).toEqual(["code", "ok"]);
  }
}
test.beforeAll(async () => {
  for (const suffix of ["a", "b"]) {
    fixtures.push(await seedReceptionistCenterFixture(`e2e-p003-cardread-${suffix}-${randomUUID()}`)); receipt("seeding");
    const f = fixtures.at(-1)!;
    const start = Date.now() + 14 * 86400_000;
    expect((await db.from("bookings").update({ status: "confirmed", noshow_card_required: true,
      start_time_utc: new Date(start).toISOString(), end_time_utc: new Date(start + 3600_000).toISOString(),
      noshow_fee_cents: suffix === "a" ? 2500 : 7900 }).eq("id", f.displayApptBookingId).eq("salon_id", f.salonId)).error).toBeNull();
    expect((await db.from("salons").update({ name: `QA Card Read ${suffix.toUpperCase()}`, currency_code: "CAD" }).eq("id", f.salonId)).error).toBeNull();
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

test("missing, malformed, random and naked booking IDs disclose no metadata", async () => {
  await denied(undefined, 400);
  for (const token of ["not-a-capability", randomUUID(), fixtures[0].displayApptBookingId]) await denied(token, 404);
});
test("other action scopes cannot read card metadata or recovery context", async () => {
  for (const action of ["status", "confirm", "reschedule", "cancel"]) await denied(await mint(action), 404);
});
test("valid capability binds the booking and salon regardless of supplied IDs", async () => {
  for (const [i, f] of fixtures.entries()) {
    const token = await mint("card_manage", f);
    const foreign = fixtures[1 - i];
    const extra = { bookingId: foreign.displayApptBookingId, salonId: foreign.salonId, slug: foreign.slug };
    const card = await get("card-info", token, extra);
    expect(card.status).toBe(200);
    expect(card.body).toMatchObject({ ok: true, salonName: `QA Card Read ${i ? "B" : "A"}`, hasCard: false, brand: "", last4: "", feeLabel: i ? "79.00 CAD" : "25.00 CAD" });
    expect(Object.keys(card.body).sort()).toEqual(["ok", "salonName", "hasCard", "brand", "last4", "cardFingerprint", "feeLabel", "status"].sort());
    const ctx = await get("save-card-context", token, extra);
    expect(ctx.status).toBe(200);
    expect(ctx.body).toMatchObject({ bookingId: f.displayApptBookingId, salonName: `QA Card Read ${i ? "B" : "A"}`, protectionStatus: "awaiting_card",
      cardRequired: true, alreadySaved: false, capturePaused: true, canRetry: false, canRefreshConsent: false, canVerifyExistingCard: false, consent: null });
    for (const key of ["client_name", "client_phone", "client_email", "noshow_card_id", "noshow_customer_id", "sourceId", "access_token"]) expect(ctx.body).not.toHaveProperty(key);
  }
  const invalidMint = await db.rpc("mint_booking_management_capability", { p_salon_id: fixtures[1].salonId, p_booking_id: fixtures[0].displayApptBookingId,
    p_action: "card_manage", p_min_expires_at: new Date(Date.now() + 600_000).toISOString() });
  expect(invalidMint.error).toBeNull(); expect(invalidMint.data).toMatchObject({ ok: false, code: "booking_not_found" });
});
test("expired and explicitly revoked capabilities are denied", async () => {
  for (const patch of [{ expires_at: new Date(Date.now() - 1000).toISOString() }, { revoked_at: new Date().toISOString(), revoke_reason: "manual_revoke" }]) {
    const token = await mint();
    expect((await db.from("booking_management_capabilities").update(patch).eq("id", token).eq("salon_id", fixtures[0].salonId)).error).toBeNull();
    await denied(token, 404);
  }
});
test("soft-deleted booking cannot disclose card or recovery metadata", async () => {
  const token = await mint(); const f = fixtures[0];
  expect((await db.from("bookings").update({ deleted_at: new Date().toISOString() }).eq("id", f.displayApptBookingId)).error).toBeNull();
  try { await denied(token, 404); }
  finally { expect((await db.from("bookings").update({ deleted_at: null }).eq("id", f.displayApptBookingId)).error).toBeNull(); }
});
test("anonymous database credentials cannot bypass HTTP capability inspection", async () => {
  const token = await mint();
  for (const [name, args] of [
    ["inspect_booking_card_recovery", { p_token_id: token }],
    ["inspect_booking_management_capability", { p_token_id: token, p_expected_action: "card_manage" }],
    ["mint_booking_management_capability", { p_salon_id: fixtures[0].salonId, p_booking_id: fixtures[0].displayApptBookingId, p_action: "card_manage", p_min_expires_at: new Date(Date.now() + 600_000).toISOString() }],
  ] as const) {
    const response = await fetch(`${qa}/rest/v1/rpc/${name}`, { method: "POST", headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    expect([401, 403]).toContain(response.status);
    expect((await response.json()).code).toBe("42501");
  }
});
test("read and reload keep booking reserved but unprotected; expired UI reveals no appointment", async ({ browser }) => {
  const token = await mint();
  const f = fixtures[0];
  const snapshot = async () => {
    const r = await db.from("bookings").select("status,noshow_card_required,noshow_card_id,noshow_customer_id,noshow_consent_at").eq("id", f.displayApptBookingId).single();
    expect(r.error).toBeNull(); return r.data;
  };
  const before = await snapshot();
  const bc = await browser.newContext({ storageState: await http.storageState(), viewport: { width: 390, height: 844 } });
  await bc.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await bc.newPage();
  try {
    await page.goto(`${origin}/booking/save-card?token=${token}`);
    const panel = page.getByTestId("card-protection-recovery");
    await expect(panel).toHaveAttribute("data-protection-status", "awaiting_card");
    await expect(panel).toContainText("Appointment reserved");
    await expect(panel).toContainText("card protection is not active");
    await expect(panel).not.toContainText("Card protection active");
    await expect(page.getByText("QA Card Read A", { exact: false })).toBeVisible();
    await expect(panel.getByRole("button")).toHaveCount(0);
    await expect(page.locator("iframe")).toHaveCount(0);
    await page.screenshot({ path: `${evidence}/reserved-paused-mobile.png`, fullPage: true });
    await page.reload(); await expect(panel).toHaveAttribute("data-protection-status", "awaiting_card");
    expect(await snapshot()).toEqual(before);
    expect((await db.from("booking_card_save_operations").select("id").eq("booking_id", f.displayApptBookingId)).data).toEqual([]);
    expect((await db.from("booking_management_capabilities").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", token)).error).toBeNull();
    await page.reload(); await expect(panel).toHaveAttribute("data-protection-status", "unavailable");
    await expect(panel).toContainText("This card management link has expired.");
    await expect(page.getByText("QA Card Read A", { exact: false })).toHaveCount(0);
    await expect(panel.getByRole("button")).toHaveCount(0);
    await page.screenshot({ path: `${evidence}/expired-mobile.png`, fullPage: true });
    expect(await snapshot()).toEqual(before);
  } finally { await bc.close(); }
});
