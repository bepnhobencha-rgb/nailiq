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
const observations: Record<string, unknown> = {};
let owner: User;
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


test.beforeAll(async () => {
  for (const suffix of ["a", "b"]) { fixtures.push(await seedReceptionistCenterFixture(`e2e-p003-c360-${suffix}-${randomUUID()}`)); save("seeding"); }
  owner = await seedTestUser(); users.push(owner); save("seeding");
  expect((await db.from("salon_members").insert({ salon_id: fixtures[0].salonId, user_id: owner.userId, role: "owner" })).error).toBeNull();
  expect((await db.from("staff").update({ name: "QA Foreign Preferred Staff" }).eq("id", fixtures[1].staffIds[0])).error).toBeNull();
  expect((await db.from("staff").update({ name: "QA Own Preferred Staff" }).eq("id", fixtures[0].staffIds[0])).error).toBeNull();
  expect((await db.from("client_profiles").insert({ id: profileId, phone, name: "E2E Profile360 Guest", preferred_staff_id: fixtures[1].staffIds[0] })).error).toBeNull();
  expect((await db.from("salon_clients").insert({ salon_id: fixtures[0].salonId, client_profile_id: profileId, source: "square_import" })).error).toBeNull();
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
test("real drawer omits a preferred staff from another salon", async ({ browser }) => {
  const { context, auth } = await login(owner);
  const bc = await browser.newContext({ storageState: await context.storageState() });
  const page = await bc.newPage();
  try {
    await page.goto(`${origin}/dashboard/${fixtures[0].slug}/clients`);
    const button = page.getByRole("button", { name: "E2E Profile360 Guest", exact: true }).filter({ visible: true }).first();
    await expect(button).toBeVisible({ timeout: 30_000 });
    const pending = page.waitForResponse(r => !!r.request().headers()["next-action"] && !!r.request().postData()?.includes(phone));
    await button.click();
    const response = await pending; const result = parseAction(await response.text());
    expect(result.ok).toBe(true); observations.foreignPreferredStaff = result.data.profile.preferredStaffName; save("testing");
    await page.screenshot({ path: `${evidence}/profile-drawer.png`, fullPage: false });
    expect(result.data.profile.preferredStaffName).toBeNull();
    expect(await page.locator("body").innerText()).not.toContain("QA Foreign Preferred Staff");
    // Replay only the observed read action with the real session and different arguments.
    const actionId = response.request().headers()["next-action"];
    const action = async (slug: string) => {
      const r = await bc.request.post(`${origin}/dashboard/${fixtures[0].slug}/clients`, {
        headers: { Origin: origin, "next-action": actionId, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component" },
        data: JSON.stringify([slug, phone, "en"]),
      });
      return parseAction(await r.text());
    };
    expect((await action(fixtures[1].slug)).ok).toBe(false);
    expect((await db.from("client_profiles").update({ preferred_staff_id: fixtures[0].staffIds[0] }).eq("id", profileId)).error).toBeNull();
    expect((await action(fixtures[0].slug)).data.profile.preferredStaffName).toBe("QA Own Preferred Staff");
    expect((await db.from("salon_members").update({ role: "nail_tech" }).eq("salon_id", fixtures[0].salonId).eq("user_id", owner.userId)).error).toBeNull();
    expect((await action(fixtures[0].slug)).ok).toBe(false);
    observations.ownStaffPreserved = true; observations.otherSalonDenied = true; observations.demotedRoleDenied = true; save("testing");
  } finally { await bc.close(); await auth.auth.signOut({ scope: "local" }); }
});
