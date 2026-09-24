import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { cleanupTestSalon, cleanupTestUser, seedTestSalonMember } from "../../e2e/helpers/db";
import { seedReceptionistCenterFixture, supabaseAdmin } from "../../e2e/receptionist-center/helpers";
import { loginReceptionist as loginRealMember } from "../../e2e/receptionist-center/realReceptionist";
import { waitForReceptionistHydration } from "../../e2e/helpers/receptionistHydration";
import { salonDateOffset } from "../../src/shared/lib/salonTime";

let fx: Awaited<ReturnType<typeof seedReceptionistCenterFixture>>;
let other: Awaited<ReturnType<typeof seedReceptionistCenterFixture>>;
let member: Awaited<ReturnType<typeof seedTestSalonMember>>;
const profileId = randomUUID();
const phone = "16045550146";
const customer = "Te2eGuestDaySixLongCustomerName";

test.beforeAll(async ({}, info) => {
  fx = await seedReceptionistCenterFixture(`e2e-day6-${info.project.name}-${randomUUID()}`);
  other = await seedReceptionistCenterFixture(`e2e-day6-other-${randomUUID()}`);
  member = await seedTestSalonMember(fx.salonId, info.project.name.includes("admin") ? "admin" : "owner");
  const profile = await supabaseAdmin.from("client_profiles").insert({ id: profileId, phone, name: customer });
  expect(profile.error?.code ?? null).toBeNull();
  const booking = await supabaseAdmin.from("bookings").update({ client_phone: phone, client_name: customer, addon_price_cents: 1000 })
    .eq("salon_id", fx.salonId).eq("status", "completed");
  expect(booking.error?.code ?? null).toBeNull();
});

test.afterAll(async () => {
  try { if (member) await cleanupTestUser(member.userId); }
  finally {
    if (fx) await cleanupTestSalon(fx.slug, { clearAllRateLimits: false });
    if (other) await cleanupTestSalon(other.slug, { clearAllRateLimits: false });
    const cleanup = await supabaseAdmin.from("client_profiles").delete().eq("id", profileId);
    expect(cleanup.error?.code ?? null).toBeNull();
  }
});

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test.beforeEach(async ({ page, context }, info) => {
  const language = info.project.name.endsWith("vi") ? "vi" : "en";
  const origin = "http://127.0.0.1:3117";
  // Mirror the real language toggle: server cookie AND client preference.
  await context.addCookies([{ name: "nailiq-user-lang", value: language, url: origin }]);
  await context.route("**/*", route => [origin, "http://127.0.0.1:54321"].includes(new URL(route.request().url()).origin)
    ? route.continue() : route.abort());
  await page.addInitScript(({ language, origin }) => {
    if (location.origin === origin) localStorage.setItem("nailiq-user-lang", language);
  }, { language, origin });
  await loginRealMember(page, member);
});

test("real owner/admin sees truthful totals, searches customers and follows tomorrow alert", async ({ page }, info) => {
  const vi = info.project.name.endsWith("vi");
  let stage = "home";
  const pageErrors: Array<{ stage: string; message: string }> = [];
  const failures: number[] = [];
  page.on("pageerror", error => pageErrors.push({ stage, message: error.message }));
  page.on("response", response => { if (response.status() >= 500 && response.url().startsWith("http://127.0.0.1:3117")) failures.push(response.status()); });
  const base = `/dashboard/${fx.slug}`;
  await expect(page.getByTestId("owner-mobile-staff-status")).toBeVisible();
  const today = page.getByRole("region", { name: vi ? "Hôm nay" : "Today", exact: true });
  await expect(today).toContainText("$55.00");
  await expect(today).toContainText(vi ? "không phải xác nhận tiền đã thu" : "not confirmation of collected payments");
  const rows = await supabaseAdmin.from("bookings").select("status,price_cents,addon_price_cents").eq("salon_id", fx.salonId);
  expect(rows.error).toBeNull();
  expect(rows.data).toHaveLength(4);
  expect(rows.data?.filter(b => b.status === "completed").reduce((sum, b) => sum + b.price_cents + (b.addon_price_cents ?? 0), 0)).toBe(5500);
  for (const id of ["owner-refresh", "owner-booking-link"]) {
    expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await noHorizontalOverflow(page);
  await page.getByTestId("owner-refresh").click();
  await expect(page.getByTestId("owner-refresh")).toHaveAttribute("aria-busy", "false");
  await expect(today).toContainText("$55.00");

  stage = "clients";
  await page.locator(`a[href="${base}/clients"]:visible`).first().click();
  const search = page.getByTestId("client-profiles-search");
  await search.fill(customer);
  await expect(page.getByTestId(`client-row-${phone}`)).toBeVisible();
  await expect(page.getByTestId(`client-row-${phone}`)).toContainText("$55");
  await expect(page.getByRole("group", { name: vi ? "Kiểu hiển thị" : "View mode", exact: true })).toBeVisible();
  await page.getByRole("button", { name: customer, exact: true }).click();
  const detail = page.getByTestId("client-360-drawer");
  await expect(detail).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText(customer);
  await expect(detail.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(detail.getByRole("alert")).toHaveCount(0);
  const customerHeading = detail.getByRole("heading", { name: customer, exact: true });
  expect(await customerHeading.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await noHorizontalOverflow(page);
  await expect(detail).toContainText("$55");
  await expect(detail).not.toContainText("$45");
  // A text-content assertion alone passes even when CSS hides the last digits.
  const kpis = detail.getByTestId("client-360-kpis");
  await expect(kpis.locator("dd")).toHaveCount(4);
  expect(await kpis.locator("dd").evaluateAll(elements => elements.every(element =>
    element.scrollWidth <= element.clientWidth + 1 && getComputedStyle(element).textOverflow !== "ellipsis",
  ))).toBe(true);
  await expect(detail).toContainText(vi ? "không phải xác nhận tiền đã thu" : "not confirmation of collected payments");
  await expect(page.getByRole("dialog").getByRole("button", { name: vi ? "Đóng" : "Close", exact: true }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail).not.toBeVisible();
  await search.fill(phone);
  await expect(page.getByTestId(`client-row-${phone}`)).toBeVisible();
  await search.fill("NoSuchSyntheticPerson");
  await expect(page.getByTestId(`client-row-${phone}`)).toHaveCount(0);
  await noHorizontalOverflow(page);

  stage = "pulse";
  await page.locator(`a[href="${base}/pulse"]:visible`).first().click();
  await expect(page.getByText("$55", { exact: true })).toBeVisible();
  await expect(page.getByText(vi ? "Vắng mặt" : "No-show", { exact: true })).toBeVisible();
  await expect(page.getByText(vi ? "Giá trị dịch vụ đã hoàn tất, không phải xác nhận tiền đã thu." : "Completed service value, not confirmation of collected payments.")).toBeVisible();
  const tomorrow = page.getByRole("link", { name: vi ? "Ngày mai chưa có hẹn nào" : "Tomorrow has no bookings yet", exact: true });
  const date = salonDateOffset(fx.timezone, 1);
  await expect(tomorrow).toHaveAttribute("href", `${base}/center?view=day&date=${date}`);
  expect((await tomorrow.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  stage = "tomorrow";
  await tomorrow.click();
  await waitForReceptionistHydration(page, fx.slug);
  await expect(page.getByRole("tab", { name: vi ? "Ngày mai" : "Tomorrow", exact: true })).toHaveAttribute("aria-selected", "true");
  // Reload a settled page. Rapid reload during RSC prefetch is tracked as a
  // separate interruption diagnostic, not this completed-page persistence gate.
  // WebKit reports canceled prefetch as a pageerror on immediate reload.
  // Chromium keeps background polling alive, so its readiness is the hydrated
  // selected-date assertion above instead of global network idleness.
  if (info.project.use.browserName === "webkit") await page.waitForLoadState("networkidle");
  stage = "reload";
  await page.reload();
  await waitForReceptionistHydration(page, fx.slug);
  await expect(page.getByRole("tab", { name: vi ? "Ngày mai" : "Tomorrow", exact: true })).toHaveAttribute("aria-selected", "true");
  await noHorizontalOverflow(page);
  await page.getByRole("tab", { name: vi ? "Hôm nay" : "Today", exact: true }).click();
  const booking = page.getByTestId(`booking-block-${fx.displayApptBookingId}`);
  await booking.click();
  const bookingDetail = page.getByTestId("booking-detail-drawer");
  await expect(bookingDetail).toContainText(fx.displayApptClientName);
  await expect(bookingDetail).toBeFocused();
  await page.keyboard.press("Escape");
  // The existing drawer stays mounted for its exit transition; closed state
  // is aria-hidden + inert on the wrapper, not removal from the DOM.
  await expect(bookingDetail.locator("..")).toHaveAttribute("aria-hidden", "true");
  await expect(bookingDetail.locator("..")).toHaveAttribute("inert", "");
  await expect.poll(() => booking.evaluate(element => element === document.activeElement || element.contains(document.activeElement))).toBe(true);
  stage = "return-home";
  await page.locator(`a[href="${base}"]:visible`).first().click();
  await expect(page.getByRole("heading", { name: vi ? "🎟 Tích điểm" : "🎟 Loyalty" })).toBeVisible();
  await expect(page.getByText(vi ? "Chưa thiết lập chương trình." : "No program configured.", { exact: false })).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(failures).toEqual([]);
});

test("initial HTML selects the requested salon date without JavaScript", async ({ browser, context }, info) => {
  const vi = info.project.name.endsWith("vi");
  const htmlContext = await browser.newContext({
    storageState: await context.storageState(), javaScriptEnabled: false,
    viewport: info.project.use.viewport,
  });
  try {
    await htmlContext.route("**/*", route => ["http://127.0.0.1:3117", "http://127.0.0.1:54321"].includes(new URL(route.request().url()).origin)
      ? route.continue() : route.abort());
    const htmlPage = await htmlContext.newPage();
    for (const offset of [-1, 0, 1, 7]) {
      await htmlPage.goto(`http://127.0.0.1:3117/dashboard/${fx.slug}/center?view=day&date=${salonDateOffset(fx.timezone, offset)}`);
      // Next streams this subtree behind Suspense; revealing it itself needs
      // JS. Inspect server markup, not the loading shell's visibility.
      const tabs = htmlPage.locator(`[role="tablist"][aria-label="${vi ? "Ngày" : "Day"}"]`);
      await expect(tabs).toHaveCount(1);
      const selected = tabs.locator('[aria-selected="true"]');
      if (offset === 7) await expect(selected).toHaveCount(0);
      else await expect(selected).toHaveText(offset === -1 ? (vi ? "Hôm qua" : "Yesterday") : offset === 0 ? (vi ? "Hôm nay" : "Today") : (vi ? "Ngày mai" : "Tomorrow"));
    }
  } finally { await htmlContext.close(); }
});

test("owner/admin cannot open another salon's reports or client directory", async ({ page }) => {
  for (const suffix of ["pulse", "clients"]) {
    await page.goto(`/dashboard/${other.slug}/${suffix}`);
    await expect(page).not.toHaveURL(new RegExp(`/dashboard/${other.slug}/`));
    await expect(page.getByTestId("client-profiles-search")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Tomorrow has no bookings|Ngày mai chưa có hẹn/ })).toHaveCount(0);
  }
});
