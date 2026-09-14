import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
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
if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) throw new Error("AI credentials must be absent for this test");
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
const observations: Record<string, unknown> = {};
let owner: User;
function save(status: string) {
  appendFileSync(`${evidence}/fixture-history.jsonl`, JSON.stringify({ status, salons: fixtures.map(f => f.salonId), users: users.map(u => u.userId), profileId }) + "\n");
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


test.beforeAll(async () => {
  for (const suffix of ["a", "b"]) { fixtures.push(await seedReceptionistCenterFixture(`e2e-p003-lookup-${suffix}-${randomUUID()}`)); save("seeding"); }
  owner = await seedTestUser(); users.push(owner); save("seeding");
  expect((await db.from("salon_members").insert({ salon_id: fixtures[0].salonId, user_id: owner.userId, role: "owner" })).error).toBeNull();
  expect((await db.from("client_profiles").insert({ id: profileId, phone, name: "E2E Lookup Guest", email: "lookup-qa@example.test", notes: "Synthetic private note" })).error).toBeNull();
  for (const [i, f] of fixtures.entries()) {
    expect((await db.from("bookings").update({ client_name: "E2E Lookup Guest", client_phone: phone, price_cents: i ? 98765 : 12345, status: "completed" }).eq("id", f.displayApptBookingId).eq("salon_id", f.salonId)).error).toBeNull();
  }
  save("ready");
});
test.afterAll(async () => {
  for (const c of clients) await c.dispose();
  // Clear the synthetic global pointer before removing its staff row.
  expect((await db.from("client_profiles").delete().eq("id", profileId)).error).toBeNull();
  for (const u of users) await cleanupTestUser(u.userId);
  for (const f of fixtures) await cleanupTestSalon(f.slug);
  save("cleaned");
});
function parseAction(body: string) {
  const line = body.split("\n").find(line => /^\w+:\{"ok":/.test(line));
  expect(line, "structured action receipt").toBeTruthy(); return JSON.parse(line!.slice(line!.indexOf(":") + 1));
}
test("phone lookup rechecks desk role, tenant and session", async ({ browser }) => {
  const { context, auth } = await login(owner);
  const bc = await browser.newContext({ storageState: await context.storageState() });
  const page = await bc.newPage();
  try {
    await page.goto(`${origin}/dashboard/${fixtures[0].slug}/center`);
    await expect(page.getByTestId("header-add-walkin")).toBeVisible({ timeout: 45_000 });
    await page.getByTestId("header-add-walkin").click();
    const input = page.getByTestId("walkin-phone").filter({ visible: true }).first();
    await expect(input).toBeVisible();
    const pending = page.waitForRequest(r => {
      if (!r.headers()["next-action"] || !r.postData()) return false;
      try { const args = JSON.parse(r.postData()!); return args[0] === fixtures[0].slug && String(args[1]).replace(/\D/g, "") === phone; } catch { return false; }
    }, { timeout: 30_000 });
    await input.fill(phone);
    const observed = await pending;
    await expect(page.getByTestId("walkin-phone-lookup-card")).toContainText("E2E Lookup Guest", { timeout: 30_000 });
    await page.screenshot({ path: `${evidence}/owner-lookup.png`, fullPage: false });
    const actionId = observed.headers()["next-action"];
    const invoke = async (slug = fixtures[0].slug, value = phone) => {
      const r = await bc.request.post(`${origin}/dashboard/${fixtures[0].slug}/center`, {
        headers: { Origin: origin, "next-action": actionId, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component" },
        data: JSON.stringify([slug, value]), maxRedirects: 0,
      });
      if ([303, 307, 308].includes(r.status())) {
        expect(new URL(r.headers().location, origin).origin).toBe(origin);
        expect(new URL(r.headers().location, origin).pathname).toBe("/login");
        return { ok: false, error: "unauthorized", transport: "login_redirect" };
      }
      const redirect = r.headers()["x-action-redirect"];
      if (redirect) {
        expect(redirect).toMatch(/^\/register(?:[;?\/]|$)/);
        return { ok: false, error: "unauthorized", transport: "action_redirect" };
      }
      return parseAction(await r.text());
    };
    for (const role of ["owner", "admin", "senior", "receptionist", "nail_tech"]) {
      expect((await db.from("salon_members").update({ role }).eq("salon_id", fixtures[0].salonId).eq("user_id", owner.userId)).error).toBeNull();
      const result = await invoke();
      observations[role] = { ok: result.ok, profileReturned: !!result.profile, privateNoteReturned: result.profile?.notes === "Synthetic private note", spend: result.profile?.total_spent_cents ?? null }; save("testing");
      if (role === "nail_tech") {
        expect.soft(result).toEqual({ ok: false, error: "unauthorized" });
        expect.soft((await invoke(fixtures[0].slug, "16045559999"))).toEqual({ ok: false, error: "unauthorized" });
      } else {
        expect(result.ok).toBe(true); expect(result.found).toBe(true);
        expect(result.profile.name).toBe("E2E Lookup Guest");
        expect(result.profile.visit_count).toBe(1);
        expect(result.profile.total_spent_cents).toBe(role === "receptionist" ? null : 12345);
      }
      expect((await invoke(fixtures[1].slug)).ok).toBe(false);
    }
    // Reload under the current receptionist role; the operational lookup
    // remains available and the prior spend redaction still works.
    expect((await db.from("salon_members").update({ role: "receptionist" }).eq("salon_id", fixtures[0].salonId).eq("user_id", owner.userId)).error).toBeNull();
    await page.reload();
    await page.getByTestId("header-add-walkin").click();
    await input.fill(phone);
    await expect(page.getByTestId("walkin-phone-lookup-card")).toContainText("E2E Lookup Guest");
    await expect(page.getByTestId("walkin-phone-lookup-card")).not.toContainText("$123.45");
    await page.screenshot({ path: `${evidence}/receptionist-lookup.png`, fullPage: false });
    await auth.auth.signOut({ scope: "local" });
    expect((await invoke()).ok).toBe(false);
    observations.revokedSessionDenied = true;
    save("testing");
  } finally { await bc.close(); await auth.auth.signOut({ scope: "local" }); }
});
