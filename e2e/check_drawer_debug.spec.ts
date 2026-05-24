import { test } from "@playwright/test";
import {
  RECEPTIONIST_E2E_SLUG,
  seedReceptionistCenterFixture,
  type ReceptionistCenterFixture,
} from "./receptionist-center/helpers";
import { cleanupTestSalon } from "./helpers/db";

let fx: ReceptionistCenterFixture;
test.beforeAll(async () => { fx = await seedReceptionistCenterFixture(); });
test.afterAll(async () => { await cleanupTestSalon(RECEPTIONIST_E2E_SLUG); });

test("debug3: console errors on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', err => errors.push('PAGE ERROR: ' + err.message));
  
  const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
  await page.context().addCookies([{
    name: "nailiq-demo-slug",
    value: fx.slug,
    url: baseURL,
  }]);
  await page.addInitScript(() => {
    try { window.localStorage.setItem("nailiq-user-lang", "en"); } catch {}
  });
  
  const q = `?date=${encodeURIComponent(fx.ymdUtc)}`;
  await page.goto(`/dashboard/${encodeURIComponent(fx.slug)}/center${q}`);
  await page.getByTestId("receptionist-center-loaded").first().waitFor({ state: "attached", timeout: 45_000 });
  await page.getByTestId("staff-timeline-grid").waitFor({ state: "visible", timeout: 45_000 });
  
  // Wait 5 seconds and check
  await page.waitForTimeout(5000);
  
  const info = await page.evaluate(() => {
    const drawer = document.querySelector('[data-testid="booking-detail-drawer"]');
    const rc = document.querySelector('[data-testid="receptionist-center-loaded"]');
    const aside = document.querySelector('[data-testid="queue-panel-slideover"]');
    return {
      drawer: !!drawer,
      rc: !!rc,
      aside: !!aside,
      asidePos: aside ? getComputedStyle(aside).position : null,
      bodyChildCount: document.body.children.length,
      bodyLastChildTag: document.body.lastElementChild?.tagName,
    };
  });
  
  console.log("DOM INFO:", JSON.stringify(info));
  console.log("ERRORS:", JSON.stringify(errors));
});
