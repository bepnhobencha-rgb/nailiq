import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { cleanupTestSalon, cleanupTestUser, seedTestSalonMember } from "../../e2e/helpers/db";
import { seedReceptionistCenterFixture, supabaseAdmin } from "../../e2e/receptionist-center/helpers";
import { loginReceptionist } from "../../e2e/receptionist-center/realReceptionist";

// Required for deterministic network-failure injection (not an offline/PWA test).
// https://playwright.dev/docs/network#missing-network-events-and-service-workers
test.use({ serviceWorkers: "block" });

let fx: Awaited<ReturnType<typeof seedReceptionistCenterFixture>>;
let member: Awaited<ReturnType<typeof seedTestSalonMember>>;
const prefix = "Te2eGuestDirectory";
const profiles = Array.from({ length: 52 }, (_, index) => ({
  id: randomUUID(), name: `${prefix}${String(index + 1).padStart(3, "0")}`,
  phone: `1604555${String(2000 + index)}`,
}));

test.beforeAll(async ({}, info) => {
  fx = await seedReceptionistCenterFixture(`e2e-directory-${info.project.name}-${randomUUID()}`);
  member = await seedTestSalonMember(fx.salonId, info.project.name.includes("admin") ? "admin" : "owner");
  const result = await supabaseAdmin.from("client_profiles").insert(profiles);
  expect(result.error).toBeNull();
  const links = await supabaseAdmin.from("salon_clients").insert(profiles.map(profile => ({ salon_id: fx.salonId, client_profile_id: profile.id, source: "manual" })));
  expect(links.error).toBeNull();
});

test.afterAll(async () => {
  try { if (member) await cleanupTestUser(member.userId); }
  finally {
    if (fx) await cleanupTestSalon(fx.slug, { clearAllRateLimits: false });
    const result = await supabaseAdmin.from("client_profiles").delete().in("id", profiles.map(profile => profile.id));
    expect(result.error).toBeNull();
  }
});

test("52 customers paginate without duplicates; search resets pages and tells the truth", async ({ page, context }, info) => {
  const vi = info.project.name.endsWith("vi");
  const language = vi ? "vi" : "en";
  const origin = "http://127.0.0.1:3117";
  await context.addCookies([{ name: "nailiq-user-lang", value: language, url: origin }]);
  await context.route("**/*", route => [origin, "http://127.0.0.1:54321"].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
  await page.addInitScript(({ language, origin }) => {
    if (location.origin === origin) localStorage.setItem("nailiq-user-lang", language);
  }, { language, origin });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await loginReceptionist(page, member);
  await expect(page.getByTestId("owner-mobile-staff-status")).toBeVisible();
  await page.locator(`a[href="/dashboard/${fx.slug}/clients"]:visible`).first().click();
  const search = page.getByTestId("client-profiles-search");
  const rows = page.locator('[data-testid^="client-row-"]');
  const next = page.getByRole("button", { name: vi ? "Tiếp" : "Next", exact: true });
  const prev = page.getByRole("button", { name: vi ? "Trước" : "Previous", exact: true });
  await search.fill(prefix);
  await expect(page.getByText(vi ? "52 khách" : "52 clients", { exact: true })).toBeVisible();
  await expect(page.getByText(vi ? "Trang 1 / 3" : "Page 1 of 3", { exact: true })).toBeVisible();
  await expect(rows).toHaveCount(25);
  await expect(rows.first()).toContainText(profiles[0].name);
  await expect(prev).toBeDisabled();
  await expect(next).toBeEnabled();
  expect.soft((await next.boundingBox())!.height, "pagination touch target").toBeGreaterThanOrEqual(44);
  const ids = await rows.evaluateAll(elements => elements.map(element => element.getAttribute("data-testid")));
  await next.click();
  await expect(page.getByText(vi ? "Trang 2 / 3" : "Page 2 of 3", { exact: true })).toBeVisible();
  await expect(next).toBeEnabled();
  await expect(rows).toHaveCount(25);
  await expect(rows.first()).toContainText(profiles[25].name);
  ids.push(...await rows.evaluateAll(elements => elements.map(element => element.getAttribute("data-testid"))));
  await next.click();
  await expect(rows).toHaveCount(2);
  await expect(page.getByText(vi ? "Trang 3 / 3" : "Page 3 of 3", { exact: true })).toBeVisible();
  await expect(next).toBeDisabled();
  await expect(prev).toBeEnabled();
  ids.push(...await rows.evaluateAll(elements => elements.map(element => element.getAttribute("data-testid"))));
  expect(new Set(ids).size).toBe(52);
  await prev.click();
  await expect(rows.first()).toContainText(profiles[25].name);
  await expect(page.getByText(vi ? "Trang 2 / 3" : "Page 2 of 3", { exact: true })).toBeVisible();
  await next.click();
  await expect(rows).toHaveCount(2);
  for (const mode of ["list", "details", "cards"]) {
    const toggle = page.getByTestId(`client-view-${mode}`);
    expect.soft((await toggle.boundingBox())!.height, "view selector touch target").toBeGreaterThanOrEqual(44);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(rows).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  }
  await search.fill(profiles[0].phone);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(profiles[0].name);
  await search.fill("NoSuchSyntheticClient");
  await expect(rows).toHaveCount(0);
  await expect.soft(page.getByText(vi ? "Không tìm thấy khách phù hợp. Thử tên hoặc số điện thoại khác." : "No matching clients. Try a different name or phone number.", { exact: true })).toBeVisible();
  await search.fill(prefix);
  await expect(rows).toHaveCount(25);
  await expect(prev).toBeDisabled();
  await expect(page.getByText(vi ? "Trang 1 / 3" : "Page 1 of 3", { exact: true })).toBeVisible();
  // Interrupt exactly one read, not a write or Auth request. The directory
  // must show a recoverable error rather than "no clients" or an app crash.
  await expect(next).toBeEnabled();
  let failedRead = false;
  await page.route(`**/dashboard/${fx.slug}/clients**`, async route => {
    const request = route.request();
    // The settled page has no writes; typing below triggers its next read.
    // Do not depend on WebKit exposing the action's request body at routing.
    if (!failedRead && request.method() === "POST") {
      failedRead = true;
      await route.fulfill({ status: 503, contentType: "text/plain", body: "Synthetic QA unavailable" });
      return;
    }
    await route.fallback();
  });
  await search.fill(profiles[1].phone);
  const error = page.getByTestId("client-profiles-error");
  await expect.poll(() => failedRead, { message: "synthetic read was actually intercepted" }).toBe(true);
  await expect(error).toBeVisible();
  expect(failedRead).toBe(true);
  await error.getByRole("button", { name: vi ? "Thử lại" : "Try again", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(profiles[1].name);
  await expect(error).toHaveCount(0);
  expect(errors).toEqual([]);
});
