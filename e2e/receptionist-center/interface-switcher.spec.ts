import { expect, test } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  gotoReceptionistCenter,
  rcSlug,
  seedReceptionistCenterFixture,
  type ReceptionistCenterFixture,
} from "./helpers";

let fx: ReceptionistCenterFixture;

test.beforeAll(async ({}, testInfo) => {
  fx = await seedReceptionistCenterFixture(rcSlug(testInfo.project.name));
});

test.beforeEach(async ({ page }) => {
  await cleanReceptionistData(fx.salonId);
  await page.addInitScript(() => {
    const initializedKey = "nailiq-interface-switcher-test-initialized";
    if (window.sessionStorage.getItem(initializedKey) !== "true") {
      window.localStorage.removeItem("nailiq-receptionist-interface");
      window.sessionStorage.setItem(initializedKey, "true");
    }
  });
});

test.afterAll(async ({}, testInfo) => {
  await cleanupTestSalon(rcSlug(testInfo.project.name));
});

test("keeps classic as default and remembers the opt-in preview", async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === "chromium") {
    await page.setViewportSize({ width: 1280, height: 853 });
  }
  await gotoReceptionistCenter(page, fx.slug);

  const center = page.getByTestId("receptionist-center-loaded");
  const switcher = page.getByTestId("receptionist-interface-switcher");

  await expect(center).toHaveAttribute("data-receptionist-interface", "classic");
  await expect(switcher).toHaveAttribute("aria-pressed", "false");

  await switcher.click();
  await expect(center).toHaveAttribute("data-receptionist-interface", "preview");
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await expect(page.getByTestId("preview-apple-header")).toBeVisible();
  }
  await expect(page.getByTestId("preview-command-bar")).toBeVisible();
  await expect(page.getByTestId("preview-command-appointments")).toBeVisible();
  await expect(page.getByTestId("preview-command-waiting")).toBeVisible();
  await expect(page.getByTestId("preview-command-late")).toBeVisible();
  await expect(page.getByTestId("preview-command-available")).toBeVisible();
  await expect(page.getByTestId("preview-command-action")).toBeVisible();
  await expect(page.getByTestId("nailiq-daily-brief")).toHaveCount(0);
  await expect(page.getByTestId("nailiq-suggestion-bar")).toHaveCount(0);
  await expect(page.getByTestId("receptionist-kpi-bar")).toHaveCount(0);
  if ((page.viewportSize()?.width ?? 0) >= 640) {
    await expect(page.getByTestId("preview-apple-shell")).toBeVisible();
    await expect(page.getByTestId("preview-apple-timeline")).toBeVisible();
    await expect(page.getByTestId("preview-walkin-queue")).toBeVisible();
    await testInfo.attach("new-receptionist-reference", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
  } else {
    const themePicker = page.getByTestId("preview-theme-picker");
    const visibleThemeTrigger = themePicker.locator("button:visible").first();
    await expect(visibleThemeTrigger).toBeVisible();
    await visibleThemeTrigger.click();
    const themePanel = page.getByTestId("preview-theme-picker-panel");
    await expect(themePanel).toBeVisible();
    const themeBox = await themePanel.boundingBox();
    expect(themeBox).not.toBeNull();
    expect(themeBox!.x).toBeGreaterThanOrEqual(0);
    expect(themeBox!.x + themeBox!.width).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
    await page.getByTestId("preview-theme-picker-backdrop").click({
      position: { x: 2, y: 2 },
    });
    await expect(themePanel).toHaveCount(0);

    const queueToggle = page.getByTestId("queue-panel-toggle");
    await expect(queueToggle).toBeVisible();
    await queueToggle.click();
    const queuePanel = page.getByTestId("queue-panel-slideover");
    await expect(queuePanel).toBeVisible();
    await expect(queuePanel).toHaveAttribute("aria-hidden", "false");
    const queueBox = await queuePanel.boundingBox();
    expect(queueBox).not.toBeNull();
    expect(queueBox!.x).toBeGreaterThanOrEqual(0);
    expect(queueBox!.x + queueBox!.width).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
    await page.getByTestId("queue-panel-backdrop").click({
      position: { x: 2, y: 2 },
    });
    await expect(queuePanel).toHaveCount(0);
  }

  await page.reload();
  await expect(center).toHaveAttribute("data-receptionist-interface", "preview");

  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await page.getByTestId("preview-settings-trigger").click();
    await page
      .getByTestId("preview-apple-header")
      .getByTestId("receptionist-interface-switcher")
      .click();
  } else {
    await page
      .locator('[data-testid="receptionist-interface-switcher"]:visible')
      .click();
  }
  await expect(center).toHaveAttribute("data-receptionist-interface", "classic");
  await expect(page.getByTestId("preview-apple-header")).toHaveCount(0);
  await expect(page.getByTestId("preview-command-bar")).toHaveCount(0);
  await expect(page.getByTestId("preview-apple-shell")).toHaveCount(0);

  await page.reload();
  await expect(center).toHaveAttribute("data-receptionist-interface", "classic");
});

test("keeps New interface calendar, search, and account navigation discoverable", async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === "chromium") {
    await page.setViewportSize({ width: 1280, height: 853 });
  }
  await gotoReceptionistCenter(page, fx.slug);
  await page
    .locator('[data-testid="receptionist-interface-switcher"]:visible')
    .click();
  await expect(page.getByTestId("receptionist-center-loaded")).toHaveAttribute(
    "data-receptionist-interface",
    "preview",
  );

  if ((page.viewportSize()?.width ?? 0) >= 768) {
    const calendarTrigger = page.getByTestId("preview-calendar-trigger");
    await expect(calendarTrigger).toBeVisible();
    await calendarTrigger.click();
    await expect(page.getByTestId("preview-calendar-menu")).toBeVisible();
    await page.getByTestId("preview-view-mode-week").click();
    await expect(page.getByTestId("week-view")).toBeVisible();

    await calendarTrigger.click();
    await page.getByTestId("preview-view-mode-month").click();
    await expect(page.getByTestId("month-view")).toBeVisible();

    await calendarTrigger.click();
    await page.getByTestId("preview-view-mode-day").click();
    await expect(page.getByTestId("preview-apple-timeline")).toBeVisible();

    const initialUrl = page.url();
    await page.getByTestId("preview-customer-search-trigger").click();
    const searchInput = page.getByTestId("preview-customer-search-input");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("ZZ");
    await page.waitForTimeout(400);
    expect(page.url()).toBe(initialUrl);

    await page.getByTestId("preview-customer-search-trigger").click();
    await page.getByTestId("preview-account-trigger").click();
    const accountMenu = page.getByTestId("preview-account-menu");
    await expect(accountMenu).toBeVisible();
    await expect(
      accountMenu.getByRole("link", { name: "Owner dashboard" }),
    ).toHaveAttribute("href", `/dashboard/${fx.slug}`);
    await expect(accountMenu.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      `/dashboard/${fx.slug}/settings`,
    );
    await expect(accountMenu.getByRole("button", { name: "Sign out" })).toBeVisible();
  } else {
    const modeToggle = page.getByTestId("view-mode-toggle");
    await expect(modeToggle).toBeVisible();
    await modeToggle.getByRole("tab", { name: "Week" }).click();
    await expect(page.getByTestId("week-view")).toBeVisible();
    await modeToggle.getByRole("tab", { name: "Month" }).click();
    await expect(page.getByTestId("month-view")).toBeVisible();
    await modeToggle.getByRole("tab", { name: "Day" }).click();

    await page.getByTestId("preview-mobile-calendar-trigger").click();
    await expect(page.getByTestId("preview-mobile-calendar-date-input")).toBeVisible();
  }
});
