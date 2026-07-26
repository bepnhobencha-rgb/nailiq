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
}) => {
  await gotoReceptionistCenter(page, fx.slug);

  const center = page.getByTestId("receptionist-center-loaded");
  const switcher = page.getByTestId("receptionist-interface-switcher");

  await expect(center).toHaveAttribute("data-receptionist-interface", "classic");
  await expect(switcher).toHaveAttribute("aria-pressed", "false");

  await switcher.click();
  await expect(center).toHaveAttribute("data-receptionist-interface", "preview");
  await expect(page.getByTestId("receptionist-kpi-bar")).toHaveAttribute(
    "data-compact",
    "true",
  );

  await page.reload();
  await expect(center).toHaveAttribute("data-receptionist-interface", "preview");

  await switcher.click();
  await expect(center).toHaveAttribute("data-receptionist-interface", "classic");

  await page.reload();
  await expect(center).toHaveAttribute("data-receptionist-interface", "classic");
});
