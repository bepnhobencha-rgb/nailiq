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
  throw new Error("Report authorization requires pinned QA with real auth and outbound OFF");
}
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== qa) throw new Error("QA auth/database transport blocked external origin");
  return nativeFetch(input, { ...init, redirect: "error" });
};
const accessUrl = readFileSync(process.env.NAILIQ_QA_PREVIEW_ACCESS_FILE!, "utf8").trim();
if (new URL(accessUrl).origin !== origin) throw new Error("Wrong Preview access origin");
const roles = ["owner", "admin", "senior", "receptionist", "nail_tech"] as const;
type Fixture = Awaited<ReturnType<typeof seedReceptionistCenterFixture>>;
type User = Awaited<ReturnType<typeof seedTestUser>>;
const fixtures: Fixture[] = [];
const users: User[] = [];
const clients: APIRequestContext[] = [];
const contexts = new Map<string, APIRequestContext>();
const userByRole = new Map<string, User>();
let baseline: unknown;
let ownerExport: { report: Record<string, unknown>; exportToken: string };

function checkpoint(status: string) {
  writeFileSync(`${evidence}/fixture-ids.json`, JSON.stringify({ status, fixtures: fixtures.map(f => ({ id: f.salonId, slug: f.slug })), users: users.map(u => u.userId) }, null, 2));
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
async function snapshot() {
  const q = await db.from("bookings").select("id,salon_id,status,price_cents,client_name").in("salon_id", fixtures.map(f => f.salonId)).order("id");
  expect(q.error).toBeNull(); return q.data;
}
function financial(slug: string) { return `/api/dashboard/financial-report?slug=${slug}&from=2026-09-01&to=2026-09-12`; }
async function exportReport(c: APIRequestContext, slug: string, data = ownerExport, format = "csv") {
  return c.post("/api/dashboard/financial-report", { headers: { Origin: origin }, data: { slug, format, ...data } });
}
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  for (const suffix of ["a", "b"]) {
    const f = await seedReceptionistCenterFixture(`e2e-p003-report-${suffix}-${randomUUID()}`);
    fixtures.push(f); checkpoint("seeding");
    const flag = await db.from("salons").update({ feature_flags: { reports_enabled: true } }).eq("id", f.salonId);
    expect(flag.error).toBeNull();
  }
  for (const role of roles) {
    const user = await seedTestUser(); users.push(user); checkpoint("seeding");
    userByRole.set(role, user);
    expect((await db.from("salon_members").insert({ salon_id: fixtures[0].salonId, user_id: user.userId, role })).error).toBeNull();
    contexts.set(role, (await login(user)).context);
  }
  const outsider = await seedTestUser(); users.push(outsider); checkpoint("seeding");
  expect((await db.from("salon_members").insert({ salon_id: fixtures[1].salonId, user_id: outsider.userId, role: "owner" })).error).toBeNull();
  contexts.set("other_owner", (await login(outsider)).context);
  const anon = await request.newContext({ baseURL: origin }); clients.push(anon); await anon.get(accessUrl); contexts.set("anonymous", anon);
  baseline = await snapshot(); checkpoint("ready");
});
test.afterAll(async () => {
  try { if (baseline) expect(await snapshot()).toEqual(baseline); }
  finally {
    for (const c of clients) await c.dispose();
    for (const u of users) await cleanupTestUser(u.userId);
    for (const f of fixtures) await cleanupTestSalon(f.slug);
    checkpoint("cleaned");
  }
});

for (const role of roles) {
  test(`${role}: reports and exports reject other salons; own access follows current gate`, async () => {
    const c = contexts.get(role)!; const a = fixtures[0]; const b = fixtures[1];
    const allowed = role === "owner" || role === "admin";
    for (const path of ["insights", "reports"]) {
      const own = await c.get(`/api/dashboard/${path}?slug=${a.slug}&range=month`);
      expect(own.status()).toBe(allowed ? 200 : 403);
      expect(own.headers()["cache-control"]).toContain("no-store");
      const cross = await c.get(`/api/dashboard/${path}?slug=${b.slug}&range=month`);
      expect(cross.status()).toBe(401); expect(await cross.json()).toEqual({ ok: false, error: "unauthorized" });
    }
    const own = await c.get(financial(a.slug)); expect(own.status()).toBe(allowed ? 200 : 403);
    if (allowed) {
      const loaded = await own.json(); expect(loaded.report.salon.id).toBe(a.salonId);
      if (role === "owner") ownerExport = loaded;
      const exported = await exportReport(c, a.slug, loaded);
      expect(exported.status()).toBe(200); expect(exported.headers()["content-type"]).toContain("text/csv");
      const csv = await exported.text(); expect(csv).not.toContain(b.salonId); expect(csv).not.toContain("@nailiq.test.invalid");
    } else {
      expect((await exportReport(c, a.slug)).status()).toBe(403);
    }
    const cross = await c.get(financial(b.slug)); expect(cross.status()).toBe(401);
    expect((await exportReport(c, b.slug)).status()).toBe(401);
  });
}
test("anonymous and another salon owner cannot retrieve or export A", async () => {
  for (const role of ["anonymous", "other_owner"]) {
    const c = contexts.get(role)!;
    expect((await c.get(financial(fixtures[0].slug))).status()).toBe(401);
    expect((await exportReport(c, fixtures[0].slug)).status()).toBe(401);
  }
});
test("signed export rejects another actor, tampering and foreign origin", async () => {
  const slug = fixtures[0].slug;
  expect((await exportReport(contexts.get("admin")!, slug)).status()).toBe(409);
  expect((await exportReport(contexts.get("owner")!, slug, { ...ownerExport, exportToken: `${ownerExport.exportToken}x` })).status()).toBe(409);
  const badOrigin = await contexts.get("owner")!.post("/api/dashboard/financial-report", { headers: { Origin: "https://untrusted.example" }, data: { slug, format: "csv", ...ownerExport } });
  expect(badOrigin.status()).toBe(403);
});
test("tenant feature OFF blocks a previously signed export", async () => {
  const a = fixtures[0];
  expect((await db.from("salons").update({ feature_flags: { reports_enabled: false } }).eq("id", a.salonId)).error).toBeNull();
  try {
    const r = await exportReport(contexts.get("owner")!, a.slug);
    expect(r.status()).toBe(403); expect((await r.json()).error).toBe("feature_not_enabled");
  } finally { expect((await db.from("salons").update({ feature_flags: { reports_enabled: true } }).eq("id", a.salonId)).error).toBeNull(); }
});
test("demotion then membership removal invalidate an existing signed export", async () => {
  const user = userByRole.get("owner")!; const a = fixtures[0]; const c = contexts.get("owner")!;
  expect((await db.from("salon_members").update({ role: "nail_tech" }).eq("salon_id", a.salonId).eq("user_id", user.userId)).error).toBeNull();
  expect((await exportReport(c, a.slug)).status()).toBe(403);
  expect((await db.from("salon_members").delete().eq("salon_id", a.salonId).eq("user_id", user.userId)).error).toBeNull();
  expect((await exportReport(c, a.slug)).status()).toBe(401);
});
test("signout rejects a still-unexpired auth cookie", async () => {
  const { context, auth } = await login(userByRole.get("admin")!);
  expect((await context.get(financial(fixtures[0].slug))).status()).toBe(200);
  expect((await auth.auth.signOut({ scope: "local" })).error).toBeNull();
  expect((await context.get(financial(fixtures[0].slug))).status()).toBe(401);
});
