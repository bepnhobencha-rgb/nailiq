import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";
import { cleanupTestSalon, cleanupTestUser, seedTestUser } from "./helpers/db";
import { waitForReceptionistHydration } from "./helpers/receptionistHydration";
import { seedReceptionistCenterFixture, supabaseAdmin, type ReceptionistCenterFixture } from "./receptionist-center/helpers";

// This acceptance harness deliberately cannot target a hosted database or app.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const appUrl = process.env.PLAYWRIGHT_BASE_URL ?? "";
if (![url, appUrl].every((value) => ["localhost", "127.0.0.1"].includes(new URL(value).hostname))
  || process.env.NAILIQ_DISPOSABLE_DB !== "1"
  || process.env.DEMO_OTP !== "false"
  || process.env.DISABLE_OUTBOUND_SMS !== "1"
  || process.env.DISABLE_OUTBOUND_EMAIL !== "1"
  || process.env.DISABLE_OUTBOUND_CALLS !== "1") {
  throw new Error("P0 tenant acceptance requires isolated loopback QA with real Auth and outbound disabled");
}
const roles = ["owner", "admin", "senior", "receptionist", "nail_tech"] as const;
type Member = Awaited<ReturnType<typeof seedTestUser>> & { role: typeof roles[number] };
let a: ReceptionistCenterFixture;
let b: ReceptionistCenterFixture;
const members: Member[] = [];
const slugs: string[] = [];

async function signIn(member: Member): Promise<SupabaseClient> {
  const client = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error } = await client.auth.signInWithPassword({ email: member.email, password: member.password });
  expect(error?.code ?? null).toBeNull();
  return client;
}

async function login(page: Page, member: Member) {
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute("data-hydrated", "true");
  await page.locator('input[inputmode="email"]').fill(member.email);
  await page.locator('input[type="password"]').fill(member.password);
  await page.getByTestId("password-signin-submit").click();
  await page.waitForURL(/\/dashboard\//);
}

async function bookingSnapshot(fixture: ReceptionistCenterFixture) {
  const result = await supabaseAdmin.from("bookings")
    .select("id,salon_id,client_name,status,start_time_utc,end_time_utc,staff_id,service_id,price_cents")
    .eq("salon_id", fixture.salonId).order("id");
  expect(result.error?.code ?? null).toBeNull();
  return result.data;
}

async function captureEditReceipt(page: Page, urlPattern: string) {
  let dispatchCount = 0;
  let resolveReceipt!: (value: { status: number; unauthorized: boolean }) => void;
  const receipt = new Promise<{ status: number; unauthorized: boolean }>((resolve) => {
    resolveReceipt = resolve;
  });
  await page.route(urlPattern, async (route) => {
    const request = route.request();
    if (request.method() !== "POST"
      || !request.headers()["next-action"]
      || !request.postData()?.includes('"newStaffId"')) {
      await route.continue();
      return;
    }
    dispatchCount += 1;
    // Forward the original request exactly once and preserve a normal reply.
    // APIResponse retains the body independently of Chromium's transient CDP
    // response buffer. Never retry a mutation or follow a redirect implicitly.
    const response = await route.fetch({ maxRetries: 0, maxRedirects: 0 });
    const result = {
      status: response.status(),
      unauthorized: (await response.text()).includes('"error":"unauthorized"'),
    };
    if (result.status >= 300 && result.status < 400) {
      // WebKit cannot fulfill a redirect. Preserve its observed status for the
      // assertion below, but never follow/replay an unexpected mutation redirect.
      await route.abort("blockedbyresponse");
    } else {
      await route.fulfill({ response });
    }
    resolveReceipt(result);
  });
  return { receipt, dispatchCount: () => dispatchCount };
}

test.beforeAll(async () => {
  for (const suffix of ["a", "b"]) {
    const slug = `e2e-p0-tenant-${suffix}-${randomUUID()}`;
    slugs.push(slug);
    const fixture = await seedReceptionistCenterFixture(slug);
    if (suffix === "a") a = fixture; else b = fixture;
  }
  for (const role of roles) {
    const user = await seedTestUser();
    members.push({ ...user, role });
    const { error } = await supabaseAdmin.from("salon_members").insert({ salon_id: a.salonId, user_id: user.userId, role });
    expect(error?.code ?? null).toBeNull();
  }
});

test.afterAll(async () => {
  try {
    for (const slug of slugs) await cleanupTestSalon(slug);
  } finally {
    for (const member of members) await cleanupTestUser(member.userId);
  }
});

for (const role of roles) {
  test(`${role}: real Auth isolates booking reads/writes and settings RPC`, async () => {
    const member = members.find((item) => item.role === role)!;
    const client = await signIn(member);
    try {
      const before = await bookingSnapshot(b);
      expect(before!.length).toBeGreaterThan(0);
      const own = await client.from("bookings").select("id,salon_id").eq("salon_id", a.salonId);
      expect(own.error?.code ?? null).toBeNull();
      expect(own.data!.length).toBeGreaterThan(0);
      const other = await client.from("bookings").select("id").eq("salon_id", b.salonId);
      expect(other.error?.code ?? null).toBeNull();
      expect(other.data).toEqual([]);
      const write = await client.from("bookings").update({ client_name: "E2E denied cross-tenant change" })
        .eq("id", b.displayApptBookingId).select("id");
      expect([null, "42501"]).toContain(write.error?.code ?? null);
      expect(write.data ?? []).toEqual([]);
      const crossSettings = await client.rpc("load_salon_owner_admin_settings", { p_salon_id: b.salonId });
      expect(crossSettings.error?.code ?? null).toBeNull();
      expect(crossSettings.data?.code).toBe("forbidden");
      const ownSettings = await client.rpc("load_salon_owner_admin_settings", { p_salon_id: a.salonId });
      expect(ownSettings.error?.code ?? null).toBeNull();
      expect(ownSettings.data?.code).toBe(role === "owner" || role === "admin" ? "loaded" : "forbidden");
      expect(await bookingSnapshot(b)).toEqual(before);
    } finally {
      await client.auth.signOut();
    }
  });
}

test("revoked session rejects its still-unexpired access token at the active-session RPC", async () => {
  const client = await signIn(members.find((item) => item.role === "senior")!);
  const session = await client.auth.getSession();
  const token = session.data.session!.access_token;
  const active = await client.rpc("current_auth_session_is_active");
  expect(active.error?.code ?? null).toBeNull();
  expect(active.data).toBe(true);
  const signedOut = await client.auth.signOut();
  expect(signedOut.error?.code ?? null).toBeNull();
  const response = await fetch(`${url}/rest/v1/rpc/current_auth_session_is_active`, {
    method: "POST", redirect: "error",
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toBe(false);
});

test("browser denies another salon and denies reload after membership removal", async ({ page }) => {
  const member = members.find((item) => item.role === "admin")!;
  await login(page, member);
  await page.goto(`/dashboard/${a.slug}/center?date=${a.ymdUtc}`);
  await expect(page.getByTestId("receptionist-center-loaded").first()).toBeVisible();
  await waitForReceptionistHydration(page, a.slug);
  await expect(page.getByTestId(`booking-block-${a.displayApptBookingId}`)).toBeVisible();
  const before = await bookingSnapshot(b);
  await page.goto(`/dashboard/${b.slug}/center?date=${b.ymdUtc}`);
  await expect(page.getByTestId("receptionist-center-loaded")).toHaveCount(0);
  await expect(page.getByTestId(`booking-block-${b.displayApptBookingId}`)).toHaveCount(0);
  expect(await bookingSnapshot(b)).toEqual(before);
  await page.goto(`/dashboard/${a.slug}/center?date=${a.ymdUtc}`);
  await expect(page.getByTestId("receptionist-center-loaded").first()).toBeVisible();
  await waitForReceptionistHydration(page, a.slug);
  await page.getByTestId(`booking-block-${a.displayApptBookingId}`).click();
  await page.getByTestId("edit-booking-button").click();
  await page.getByTestId("edit-staff-select").selectOption(a.staffIds[1]);
  await expect(page.getByTestId("edit-save-button")).toBeEnabled();
  const beforeRemoval = await bookingSnapshot(a);
  const client = await signIn(member);
  try {
    const removed = await supabaseAdmin.from("salon_members").delete()
      .eq("salon_id", a.salonId).eq("user_id", member.userId).select("user_id");
    expect(removed.error?.code ?? null).toBeNull();
    expect(removed.data).toHaveLength(1);
    const denied = await client.from("bookings").select("id").eq("salon_id", a.salonId);
    expect(denied.error?.code ?? null).toBeNull();
    expect(denied.data).toEqual([]);
    // A form opened while authorized must not retain permission after removal.
    const actionResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && Boolean(response.request().headers()["next-action"])
      && Boolean(response.request().postData()?.includes('"newStaffId"')));
    await page.getByTestId("edit-save-button").click();
    // With no remaining memberships the proxy rejects before the action runs.
    // A redirect has no readable response body in Playwright.
    const rejected = await actionResponse;
    expect(rejected.status()).toBe(307);
    expect(new URL(rejected.headers().location, appUrl).pathname).toBe("/register/setup");
    expect(await bookingSnapshot(a)).toEqual(beforeRemoval);
    await expect(page.getByTestId("edit-error-message")).toHaveText(
      "We could not confirm the save result. Reload to check the booking and your access before trying again.",
    );
    await expect(page.getByTestId("edit-save-button")).toBeDisabled();
    await expect(page.getByTestId("edit-save-button")).not.toHaveText(/Saving/);
    await page.getByTestId("edit-reload-button").click();
    await expect(page).toHaveURL(/\/register\/setup/);
    await expect(page.getByTestId("receptionist-center-loaded")).toHaveCount(0);
    await expect(page.getByTestId(`booking-block-${a.displayApptBookingId}`)).toHaveCount(0);
  } finally {
    await client.auth.signOut();
  }
});

for (const lang of ["en", "vi"] as const) {
test(`${lang}: an already-open edit form loses write permission after admin is demoted`, async ({ page }, testInfo) => {
  await page.addInitScript((language) => localStorage.setItem("nailiq-user-lang", language), lang);
  const user = await seedTestUser();
  const member: Member = { ...user, role: "admin" };
  members.push(member);
  const grant = await supabaseAdmin.from("salon_members").insert({ salon_id: a.salonId, user_id: member.userId, role: "admin" });
  expect(grant.error?.code ?? null).toBeNull();
  await login(page, member);
  await page.goto(`/dashboard/${a.slug}/center?date=${a.ymdUtc}`);
  await waitForReceptionistHydration(page, a.slug);
  await page.getByTestId(`booking-block-${a.displayApptBookingId}`).click();
  await page.getByTestId("edit-booking-button").click();
  await page.getByTestId("edit-staff-select").selectOption(a.staffIds[1]);
  await expect(page.getByTestId("edit-save-button")).toBeEnabled();
  const before = await bookingSnapshot(a);
  const demotion = await supabaseAdmin.from("salon_members").update({ role: "nail_tech" })
    .eq("salon_id", a.salonId).eq("user_id", member.userId).select("role");
  expect(demotion.error?.code ?? null).toBeNull();
  expect(demotion.data).toEqual([{ role: "nail_tech" }]);
  const urlPattern = `**/dashboard/${a.slug}/center**`;
  const capture = await captureEditReceipt(page, urlPattern);
  await page.getByTestId("edit-save-button").click();
  const response = await capture.receipt;
  expect(response.status).toBe(200);
  expect(response.unauthorized).toBe(true);
  expect(capture.dispatchCount()).toBe(1);
  await expect(page.getByTestId("edit-error-message")).toHaveText(
    lang === "en"
      ? "Your current access does not allow booking edits. Sign in again or ask the salon owner to check your permissions."
      : "Quyền truy cập hiện tại không cho phép sửa lịch hẹn. Hãy đăng nhập lại hoặc nhờ chủ tiệm kiểm tra quyền của bạn.",
  );
  expect(await bookingSnapshot(a)).toEqual(before);
  await page.unroute(urlPattern);
  if (process.env.NAILIQ_QA_ARTIFACT_DIR) {
    await page.getByTestId("edit-error-message").screenshot({
      path: `${process.env.NAILIQ_QA_ARTIFACT_DIR}/p0-03-demoted-${testInfo.project.name}-${lang}.png`,
    });
  }
  await page.reload();
  await waitForReceptionistHydration(page, a.slug);
  await page.getByTestId(`booking-block-${a.displayApptBookingId}`).click();
  await expect(page.getByTestId("edit-booking-button")).toHaveCount(0);
});
}
