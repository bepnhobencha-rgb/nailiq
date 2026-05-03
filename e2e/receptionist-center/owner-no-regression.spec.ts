import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  gotoOwnerDashboard,
  RECEPTIONIST_E2E_SLUG,
  seedReceptionistCenterFixture,
  seedWalkin,
  testClientNameMarker,
  type ReceptionistCenterFixture,
} from "./helpers";

let fx: ReceptionistCenterFixture;

test.beforeAll(async () => {
  fx = await seedReceptionistCenterFixture();
});

test.beforeEach(async () => {
  await cleanReceptionistData(fx.salonId);
});

test.afterAll(async () => {
  await cleanupTestSalon(RECEPTIONIST_E2E_SLUG);
});

test.describe("Owner dashboard regression", () => {
  test("case 8: today agenda excludes waiting walk-ins; stats show completed", async ({
    page,
  }) => {
    const marker = testClientNameMarker();
    await seedWalkin(fx.salonId, {
      clientName: marker,
      serviceId: fx.serviceIds[0]!,
    });

    await gotoOwnerDashboard(page, fx.slug);

    await expect(page.getByText(marker)).toHaveCount(0);

    await expect(page.getByText("RC Display Appt")).toBeVisible();

    const summary = page.getByRole("region", { name: /^Today$/i });
    await expect(summary).toBeVisible();

    const completedLabel = summary.getByText(/completed|hoàn thành/i).first();
    await expect(completedLabel).toBeVisible();
    await expect(completedLabel.locator("..").locator("p.tabular-nums").first()).toHaveText(
      /^[1-9]/,
    );
  });
});
