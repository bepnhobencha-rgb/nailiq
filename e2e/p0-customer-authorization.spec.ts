import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServerClient } from "@supabase/ssr";
import { test, expect, request, type APIRequestContext } from "@playwright/test";
import { seedTestUser, cleanupTestUser, cleanupTestSalon } from "./helpers/db";
import { seedReceptionistCenterFixture, supabaseAdmin as db } from "./receptionist-center/helpers";

const origin = "https://nailiq-p0-signup-qa-20260911.vercel.app";
const qa = "https://osdqutwunokiielbairj.supabase.co";
const evidence = process.env.NAILIQ_QA_ARTIFACT_DIR!;
if (process.env.PLAYWRIGHT_BASE_URL !== origin || process.env.NEXT_PUBLIC_SUPABASE_URL !== qa
  || process.env.SUPABASE_INTERNAL_URL !== qa || process.env.DEMO_OTP !== "false"
  || ["DISABLE_OUTBOUND_SMS", "DISABLE_OUTBOUND_EMAIL", "DISABLE_OUTBOUND_CALLS"].some(k => process.env[k] !== "1")) {
  throw new Error("Customer authorization requires pinned QA with real auth and outbound OFF");
}
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== qa) throw new Error("QA auth/database transport blocked external origin");
  return nativeFetch(input, { ...init, redirect: "error" });
};
const accessUrl = readFileSync(process.env.NAILIQ_QA_PREVIEW_ACCESS_FILE!, "utf8").trim();
if (new URL(accessUrl).origin !== origin) throw new Error("Wrong Preview access origin");

type Fixture = Awaited<ReturnType<typeof seedReceptionistCenterFixture>>;
type User = Awaited<ReturnType<typeof seedTestUser>>;
const fixtures: Fixture[] = [];
const users: User[] = [];
const clients: APIRequestContext[] = [];
const profileId = randomUUID();
const phone = `1604555${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
const otpA = randomUUID(); const otpB = randomUUID();
let anon: APIRequestContext;
let owner: User;
const observations: Record<string, unknown> = {};
function save(status: string) {
  writeFileSync(`${evidence}/fixture-ids.json`, JSON.stringify({ status, salons: fixtures.map(f => ({ id: f.salonId, slug: f.slug })), users: users.map(u => u.userId), profileId, observations }, null, 2));
}
async function login(user: User) {
  const jar = new Map<string, string>();
  const auth = createServerClient(qa, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: values => { for (const v of values) jar.set(v.name, v.value); } },
  });
  const result = await auth.auth.signInWithPassword({ email: user.email, password: user.password });
  expect(result.error).toBeNull();
  const context = await request.newContext({ baseURL: origin, storageState: { origins: [], cookies: [...jar].map(([name, value]) => ({ name, value, domain: new URL(origin).hostname, path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" as const })) } });
  clients.push(context);
  await context.get(accessUrl);
  return { context, auth };
}

function consentPath(salonId: string) { return `/api/customer/${phone}/consents?salon_id=${salonId}`; }
function profilePath(otp = otpA, salonId = fixtures[0].salonId, targetPhone = phone) {
  return `/api/customer/profile-verified?otp_session_id=${otp}&salon_id=${salonId}&phone=${targetPhone}`;
}
test.beforeAll(async () => {
  for (const suffix of ["a", "b"]) {
    fixtures.push(await seedReceptionistCenterFixture(`e2e-p003-customer-${suffix}-${randomUUID()}`)); save("seeding");
  }
  owner = await seedTestUser(); users.push(owner); save("seeding");
  expect((await db.from("salon_members").insert({ salon_id: fixtures[0].salonId, user_id: owner.userId, role: "owner" })).error).toBeNull();
  expect((await db.from("client_profiles").insert({ id: profileId, phone, name: "E2E Private Customer", email: "private-customer@example.test", is_vip: true })).error).toBeNull();
  for (const [index, f] of fixtures.entries()) {
    expect((await db.from("bookings").update({ client_phone: phone }).eq("id", f.displayApptBookingId).eq("salon_id", f.salonId)).error).toBeNull();
    expect((await db.from("phone_otp_sessions").insert({ id: index === 0 ? otpA : otpB, salon_id: f.salonId, phone, expires_at: new Date(Date.now() + 600_000).toISOString() })).error).toBeNull();
    expect((await db.from("customer_photo_consents").insert({ salon_id: f.salonId, client_phone: phone, client_profile_id: profileId, consent_use_marketing: true })).error).toBeNull();
  }
  anon = await request.newContext({ baseURL: origin }); clients.push(anon); await anon.get(accessUrl); save("ready");
});
test.afterAll(async () => {
  for (const c of clients) await c.dispose();
  for (const u of users) await cleanupTestUser(u.userId);
  for (const f of fixtures) await cleanupTestSalon(f.slug);
  expect((await db.from("client_profiles").delete().eq("id", profileId)).error).toBeNull(); save("cleaned");
});
test("anonymous recognition exposes only found/VIP and no profile or history", async () => {
  const r = await anon.get(`/api/customer/${phone}?salon_id=${fixtures[0].salonId}`);
  expect(r.status()).toBe(200); expect(await r.json()).toEqual({ found: true, isVip: true });
});
test("verified profile binds OTP to phone and salon; own history stays scoped", async () => {
  const r = await anon.get(profilePath()); expect(r.status()).toBe(200);
  const data = await r.json(); expect(data.name).toBe("E2E Private Customer"); expect(data.email).toBe("private-customer@example.test");
  expect(data.visitCount).toBe(1); expect(data.lastBooking.serviceId).toBe(fixtures[0].serviceIds[0]);
  const session = await db.from("phone_otp_sessions").select("consumed_at").eq("id", otpA).single();
  expect(session.error).toBeNull(); expect(session.data?.consumed_at).toBeNull();
  expect((await anon.get(profilePath(otpA, fixtures[1].salonId))).status()).toBe(401);
  expect((await anon.get(profilePath(otpA, fixtures[0].salonId, "16045550001" === phone ? "16045550002" : "16045550001"))).status()).toBe(401);
  expect((await db.from("phone_otp_sessions").update({ consumed_at: new Date().toISOString() }).eq("id", otpA)).error).toBeNull();
  expect((await anon.get(profilePath())).status()).toBe(401);
  expect((await db.from("phone_otp_sessions").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", otpB)).error).toBeNull();
  expect((await anon.get(profilePath(otpB, fixtures[1].salonId))).status()).toBe(401);
});
test("consent read permits current member and rejects another salon/anonymous", async () => {
  const { context, auth } = await login(owner);
  expect((await context.get(consentPath(fixtures[0].salonId))).status()).toBe(200);
  expect((await context.get(consentPath(fixtures[1].salonId))).status()).toBe(403);
  expect((await anon.get(consentPath(fixtures[0].salonId))).status()).toBe(401);
  await auth.auth.signOut({ scope: "local" });
});
test("revoked session cannot read consents using an unexpired cookie", async () => {
  const { context, auth } = await login(owner);
  expect((await context.get(consentPath(fixtures[0].salonId))).status()).toBe(200);
  expect((await auth.auth.signOut({ scope: "local" })).error).toBeNull();
  const r = await context.get(consentPath(fixtures[0].salonId)); observations.revokedReadStatus = r.status(); save("testing");
  expect(r.status()).toBe(401);
});
test("revoked session cannot revoke consent using an unexpired cookie", async () => {
  const { context, auth } = await login(owner);
  expect((await auth.auth.signOut({ scope: "local" })).error).toBeNull();
  const r = await context.patch(`/api/customer/${phone}/consents`, { headers: { Origin: origin }, data: { salon_id: fixtures[0].salonId, revoked_reason: "E2E denied stale-session attempt" } });
  const row = await db.from("customer_photo_consents").select("revoked_at").eq("salon_id", fixtures[0].salonId).eq("client_phone", phone).single();
  expect(row.error).toBeNull(); observations.revokedWriteStatus = r.status(); observations.revocationOccurred = row.data?.revoked_at !== null; save("testing");
  expect(r.status()).toBe(401); expect(row.data?.revoked_at).toBeNull();
});
test("malformed consent JSON is a client error instead of a server crash", async () => {
  const r = await anon.patch(`/api/customer/${phone}/consents`, {
    headers: { Origin: origin, "Content-Type": "application/json" }, data: "null",
  });
  observations.malformedBodyStatus = r.status(); save("testing");
  expect(r.status()).toBe(400);
});
test("valid current member revokes only the selected salon consent", async () => {
  const { context, auth } = await login(owner);
  const r = await context.patch(`/api/customer/${phone}/consents`, {
    headers: { Origin: origin }, data: { salon_id: fixtures[0].salonId, revoked_reason: "  E2E authorized synthetic request  " },
  });
  expect(r.status()).toBe(200);
  const rows = await db.from("customer_photo_consents").select("salon_id,revoked_at,revoked_reason").in("salon_id", fixtures.map(f => f.salonId)).eq("client_phone", phone);
  expect(rows.error).toBeNull();
  const a = rows.data?.find(row => row.salon_id === fixtures[0].salonId);
  const b = rows.data?.find(row => row.salon_id === fixtures[1].salonId);
  expect(a?.revoked_at).toBeTruthy(); expect(a?.revoked_reason).toBe("E2E authorized synthetic request"); expect(b?.revoked_at).toBeNull();
  observations.validRevocationScoped = true; save("testing"); await auth.auth.signOut({ scope: "local" });
});
