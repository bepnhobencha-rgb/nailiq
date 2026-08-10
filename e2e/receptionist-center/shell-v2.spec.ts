import { expect, test, type Page } from "@playwright/test";

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

test.beforeEach(async () => {
  await cleanReceptionistData(fx.salonId);
});

test.afterAll(async ({}, testInfo) => {
  await cleanupTestSalon(rcSlug(testInfo.project.name));
});

async function expectCalmShell(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await gotoReceptionistCenter(page, fx.slug, {
    expectWalkinQueue: false,
    shellV2: true,
  });

  const shell = page.getByTestId("receptionist-center-loaded").last();
  await expect(shell).toHaveAttribute("data-receptionist-shell", "v2");
  await expect(shell).toHaveAttribute("data-receptionist-density", "pro");
  await expect(page.getByTestId("nailiq-suggestion-bar")).toBeVisible();
  await expect(page.getByTestId("nailiq-daily-brief-summary")).toHaveCount(0);
  await expect(page.getByTestId("receptionist-kpi-bar")).toHaveCount(0);
  await expect(page.getByTestId("receptionist-display-menu-trigger")).toHaveCount(0);
  await expect(page.getByTestId("header-add-walkin")).toHaveCount(0);
  await expect(page.getByTestId("header-add-appointment")).toHaveCount(0);
  await expect(page.getByTestId("header-add-group")).toHaveCount(0);

  const createTrigger =
    width < 640
      ? page.getByTestId("mobile-create-menu-trigger")
      : page.getByTestId("receptionist-create-trigger");
  await expect(createTrigger).toBeVisible();
  const box = await createTrigger.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);

  await createTrigger.click();
  await expect(
    width < 640
      ? page.getByTestId("mobile-create-appointment")
      : page.getByTestId("create-menu-appointment"),
  ).toBeVisible();

  await expect(
    width < 640
      ? page.getByTestId("vertical-day-view")
      : page.getByTestId("staff-timeline-grid"),
  ).toBeVisible();
}

test.describe("Receptionist option-B shell", () => {
  test("desktop keeps the proven grid and one create entry", async ({ page }) => {
    await expectCalmShell(page, 1440, 900);
  });

  test("iPad keeps the proven grid and one create entry", async ({ page }) => {
    await expectCalmShell(page, 820, 1180);
  });

  test("mobile keeps the vertical schedule and one create entry", async ({ page }) => {
    await expectCalmShell(page, 390, 844);
  });
});
