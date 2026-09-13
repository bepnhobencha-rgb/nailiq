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
  for (const suffix of ["a", "b"]) { fixtures.push(await seedReceptionistCenterFixture(`e2e-p003-spend-${suffix}-${randomUUID()}`)); save("seeding"); }
  owner = await seedTestUser(); users.push(owner); save("seeding");
  expect((await db.from("salon_members").insert({ salon_id: fixtures[0].salonId, user_id: owner.userId, role: "owner" })).error).toBeNull();
  expect((await db.from("staff").update({ name: "QA Foreign Preferred Staff" }).eq("id", fixtures[1].staffIds[0])).error).toBeNull();
  expect((await db.from("staff").update({ name: "QA Own Preferred Staff" }).eq("id", fixtures[0].staffIds[0])).error).toBeNull();
  expect((await db.from("client_profiles").insert({ id: profileId, phone, name: "E2E Spend Guest", preferred_staff_id: fixtures[1].staffIds[0] })).error).toBeNull();
  expect((await db.from("salon_clients").insert({ salon_id: fixtures[0].salonId, client_profile_id: profileId, source: "square_import" })).error).toBeNull();
  expect((await db.from("salon_client_spend").insert({ salon_id: fixtures[0].salonId, client_profile_id: profileId, total_spend_cents: 54321, payment_count: 1 })).error).toBeNull();
  expect((await db.from("client_ai_summaries").insert({ salon_id: fixtures[0].salonId, client_profile_id: profileId, summary_text: "QA financial summary: lifetime spend $543.21", next_action: "QA private financial recommendation", visit_count: 1, lang: "en" })).error).toBeNull();
  expect((await db.from("bookings").update({ client_name: "E2E Spend Guest", client_phone: phone, price_cents: 12345, status: "completed" }).eq("id", fixtures[0].displayApptBookingId).eq("salon_id", fixtures[0].salonId)).error).toBeNull();
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
let observedGenerateAction: string | undefined;
for (const role of ["owner", "admin", "senior", "receptionist"] as const) {
test(`${role}: client spend projection, history and summary`, async ({ browser }) => {
  expect((await db.from("salon_members").update({ role }).eq("salon_id", fixtures[0].salonId).eq("user_id", owner.userId)).error).toBeNull();
  const { context, auth } = await login(owner);
  const bc = await browser.newContext({ storageState: await context.storageState(), ...(test.info().project.name === "mobile-webkit" ? { viewport: { width: 390, height: 844 }, isMobile: true } : {}) });
  const page = await bc.newPage();
  try {
    const directoryResponse = page.waitForResponse(r => !!r.request().headers()["next-action"] && !!r.request().postData()?.includes(fixtures[0].slug) && !!r.request().postData()?.includes("pageSize"));
    await page.goto(`${origin}/dashboard/${fixtures[0].slug}/clients`);
    const directoryRequest = (await directoryResponse).request();
    const directory = parseAction(await (await bc.request.fetch(directoryRequest)).text());
    const roleObservations: Record<string, unknown> = {}; observations[role] = roleObservations;
    roleObservations.directorySpend = directory.clients?.find((c: { phone: string }) => c.phone === phone)?.totalSpentCents;
    const button = page.getByRole("button", { name: "E2E Spend Guest", exact: true }).filter({ visible: true }).first();
    await expect(button).toBeVisible({ timeout: 30_000 });
    const pending = page.waitForResponse(r => !!r.request().headers()["next-action"] && r.request().postData() === JSON.stringify([fixtures[0].slug, phone, "en"]));
    await button.click();
    const response = await pending;
    // Chromium can discard a streamed RSC response body. Reuse the observed
    // request for a read-only HTTP assertion; verify its UI separately below.
    const readback = await bc.request.fetch(response.request());
    const result = parseAction(await readback.text());
    expect(result.ok).toBe(true);
    roleObservations.profileSpend = result.data.stats.lifetimeSpentCents;
    roleObservations.profileAvg = result.data.stats.avgTicketCents;
    roleObservations.cachedSummary = result.data.aiSummary?.text ?? null;
    save("testing");
    await expect(page.getByText("E2E Spend Guest", { exact: true }).last()).toBeVisible();
    await page.screenshot({ path: `${evidence}/${test.info().project.name}-${role}-profile.png`, fullPage: false });
    const canSpend = role !== "receptionist";
    expect.soft(result.data.stats.lifetimeSpentCents).toBe(canSpend ? 54321 : null);
    expect.soft(result.data.stats.avgTicketCents).toBe(canSpend ? 54321 : null);
    expect.soft(result.data.timeline[0].priceCents).toBe(canSpend ? 12345 : null);
    expect(result.data.stats.visitCount).toBe(1);
    expect.soft(roleObservations.directorySpend).toBe(canSpend ? 12345 : null);
    if (canSpend) {
      expect(result.data.aiSummary?.text).toContain("QA financial summary");
      await expect(page.getByText("$123.45", { exact: true })).toBeVisible();
    }
    else {
      expect.soft(result.data.aiSummary).toBeNull();
      expect.soft(await page.locator("body").innerText()).not.toContain("QA financial summary");
      expect.soft(await page.locator("body").innerText()).not.toMatch(/\$543|\$123/);
      await expect.soft(page.getByText(/^Lifetime$/i)).toHaveCount(0);
      await expect.soft(page.getByText(/^Avg ticket$/i)).toHaveCount(0);
    }
    const invoke = async (id: string, slug: string) => {
      const r = await bc.request.post(`${origin}/dashboard/${fixtures[0].slug}/clients`, {
        headers: { Origin: origin, "next-action": id, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component" },
        data: JSON.stringify([slug, phone, "en"]),
      }); return parseAction(await r.text());
    };
    const loadAction = response.request().headers()["next-action"];
    expect((await invoke(loadAction, fixtures[1].slug)).ok).toBe(false);
    if (role === "owner") {
      // QA contains no AI provider credentials. Observe the real regeneration
      // action to verify direct-call authorization after membership changes.
      const regen = page.waitForResponse(r => !!r.request().headers()["next-action"] && r.request().headers()["next-action"] !== loadAction && !!r.request().postData()?.includes(phone));
      await page.getByRole("button", { name: "↺ Regenerate" }).click();
      const response = await regen; observedGenerateAction = response.request().headers()["next-action"];
      expect(response.status()).toBe(200);
    }
    if (role === "receptionist") {
      expect(observedGenerateAction).toBeTruthy();
      expect.soft(await invoke(observedGenerateAction!, fixtures[0].slug)).toEqual({ ok: false, error: "unauthorized" });
      await page.reload();
      await page.getByRole("button", { name: "E2E Spend Guest", exact: true }).filter({ visible: true }).first().click();
      await expect(page.getByText(/^Lifetime$/i)).toHaveCount(0);
      expect((await invoke(loadAction, fixtures[0].slug)).data.stats.lifetimeSpentCents).toBeNull();
      expect((await db.from("salon_members").update({ role: "nail_tech" }).eq("salon_id", fixtures[0].salonId).eq("user_id", owner.userId)).error).toBeNull();
      expect((await invoke(loadAction, fixtures[0].slug)).ok).toBe(false);
    }
    save("testing");
  } finally { await bc.close(); await auth.auth.signOut({ scope: "local" }); }
});
}
