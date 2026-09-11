import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { cleanupTestSalon } from "../helpers/db";
import { fillMemberCard, gotoGroupFlow, nextOpenDateYmd, pickDateInCalendar, seedGroupTestSalon } from "./helpers";

const SLUG = "e2e-group-quote-recovery";
let salonId: string;

async function reachConfirmation(page: Page) {
  await gotoGroupFlow(page, SLUG);
  await page.getByTestId("group-size-2").click();
  await page.getByTestId("group-size-next").click();
  await fillMemberCard(page, 0, "Mai", 1, 1);
  await fillMemberCard(page, 1, "Linh", 1, 2);
  await page.getByTestId("group-service-next").click();
  await pickDateInCalendar(page, nextOpenDateYmd());
  await page.getByTestId("group-arrival-afternoon").click();
  await page.getByTestId("group-date-next").click();
  await page.getByTestId("group-arrangement-best").click();
  await page.getByTestId("group-arrangement-next").click();
  await expect(page.getByTestId("group-step-confirm-panel")).toBeVisible();
}

test.beforeAll(async ({}, info) => {
  ({ salonId } = await seedGroupTestSalon(SLUG));
  if (info.project.name === "mobile") {
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const result = await db.from("salons").update({ theme_mode: "light" }).eq("id", salonId);
    expect(result.error).toBeNull();
  }
});
test.afterAll(async () => {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  try {
    const result = await db.from("bookings").select("id", { count: "exact", head: true }).eq("salon_id", salonId);
    expect(result.error).toBeNull();
    expect(result.count).toBe(0); // Re-quotes and recovery must never commit a booking.
  } finally { await cleanupTestSalon(SLUG); }
});

test("503 retains details; deliberate retry obtains a real SQL quote without booking", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/booking/group-quote", async (route) => {
    attempts++;
    if (attempts === 1) await route.fulfill({ status: 503, json: { ok: false, code: "quote_unavailable" } });
    else await route.continue();
  });
  await reachConfirmation(page);
  await expect(page.getByTestId("group-pricing-unavailable")).toBeVisible();
  await expect(page.getByTestId("group-confirm")).toBeDisabled();
  // Scroll and verify hit-testing without submitting; fixed mobile footers
  // must not cover the recovery action in the captured viewport.
  await page.getByTestId("group-pricing-recover").click({ trial: true });
  const retryBox = await page.getByTestId("group-pricing-recover").boundingBox();
  expect(retryBox?.height).toBeGreaterThanOrEqual(44);
  expect(retryBox!.x).toBeGreaterThanOrEqual(0);
  expect(retryBox!.x + retryBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: `${test.info().outputDir}/unavailable-quote.png`, fullPage: true });
  expect(attempts).toBe(1);
  await page.getByTestId("group-pricing-recover").click();
  await expect(page.getByTestId("group-authoritative-receipt")).toBeVisible();
  await expect(page.getByTestId("group-confirm")).toBeEnabled();
  expect(attempts).toBe(2);
  await page.screenshot({ path: `${test.info().outputDir}/recovered-quote.png`, fullPage: true });
});

test("a quote-time conflict offers a fresh schedule instead of a dead-end 503", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/booking/group-quote", async (route) => {
    if (++attempts === 1) {
      // Exercise the real API and SQL: stale service duration no longer matches
      // the schedule. The authoritative quote must reject it as invalid_time.
      const body = route.request().postDataJSON();
      body.bookings[0].endTimeUtc = new Date(Date.parse(body.bookings[0].endTimeUtc) + 60_000).toISOString();
      await route.continue({ postData: JSON.stringify(body) });
    }
    else await route.continue();
  });
  await reachConfirmation(page);
  await expect(page.getByTestId("group-pricing-recover")).toHaveText(/Choose another time|Chọn lại giờ/);
  await page.screenshot({ path: `${test.info().outputDir}/conflict-recovery.png`, fullPage: true });
  await page.getByTestId("group-pricing-recover").click();
  await expect(page.getByTestId("group-step-arrangement-panel")).toBeVisible();
  await page.getByTestId("group-arrangement-best").click();
  await page.getByTestId("group-arrangement-next").click();
  await expect(page.getByTestId("group-authoritative-receipt")).toBeVisible();
});

test("a slow old error cannot erase the current authoritative quote", async ({ page }) => {
  let releaseOld!: () => void;
  const hold = new Promise<void>((resolve) => { releaseOld = resolve; });
  let attempts = 0;
  await page.route("**/api/booking/group-quote", async (route) => {
    if (++attempts === 1) {
      await hold;
      await route.fulfill({ status: 503, json: { ok: false, code: "quote_unavailable" } }).catch(() => {});
    } else await route.continue();
  });
  await reachConfirmation(page);
  await expect.poll(() => attempts).toBe(1);
  await page.getByTestId("group-primary-email").fill("qa-recovery@example.test");
  await expect(page.getByTestId("group-authoritative-receipt")).toBeVisible();
  releaseOld();
  await expect(page.getByTestId("group-pricing-unavailable")).not.toBeVisible();
  await expect(page.getByTestId("group-confirm")).toBeEnabled();
});

test("the real SQL rejects an unavailable service and UI returns to selection", async ({ page }) => {
  await page.route("**/api/booking/group-quote", async (route) => {
    const body = route.request().postDataJSON();
    body.bookings[0].serviceId = "aaa00000-0000-4000-8000-000000000099";
    await route.continue({ postData: JSON.stringify(body) });
  });
  await reachConfirmation(page);
  await expect(page.getByTestId("group-pricing-unavailable")).toContainText(/service or staff|Dịch vụ hoặc thợ/);
  await expect(page.getByTestId("group-confirm")).toBeDisabled();
  await page.getByTestId("group-pricing-recover").click();
  await expect(page.getByTestId("group-step-service-panel")).toBeVisible();
  await expect(page.getByTestId("group-member-1-name")).toHaveValue("Linh");
});

test("read timeout stops loading and permits a new quote, with no automatic replay", async ({ page }) => {
  let releaseOld!: () => void;
  const hold = new Promise<void>((resolve) => { releaseOld = resolve; });
  let attempts = 0;
  await page.route("**/api/booking/group-quote", async (route) => {
    if (++attempts === 1) {
      await hold;
      await route.abort().catch(() => {});
    } else await route.continue();
  });
  await reachConfirmation(page);
  const started = Date.now();
  await expect(page.getByTestId("group-pricing-loading")).toBeVisible();
  await expect(page.getByTestId("group-pricing-recover")).toBeVisible({ timeout: 20_000 });
  expect(Date.now() - started).toBeGreaterThan(13_000);
  expect(attempts).toBe(1);
  releaseOld();
  await page.getByTestId("group-pricing-recover").click();
  await expect(page.getByTestId("group-authoritative-receipt")).toBeVisible();
  expect(attempts).toBe(2);
});
