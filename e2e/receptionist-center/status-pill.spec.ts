import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  gotoReceptionistCenter,
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

test.describe("Status pill", () => {
  test("case 9: busy state after four waiting walk-ins", async ({ page }) => {
    for (let i = 0; i < 4; i += 1) {
      await seedWalkin(fx.salonId, {
        /** Prefix Te2eGuest so cleanReceptionistData clears rows between tests */
        clientName: `${testClientNameMarker()}pill${i}`,
        serviceId: fx.serviceIds[0]!,
      });
    }

    await gotoReceptionistCenter(page, fx.slug);

    const pill = page.getByTestId("status-pill");
    await expect(pill).toHaveAttribute("data-state", "busy");
    await expect(pill).toContainText(/\b4\b/);
  });

  test("calm state when queue empty", async ({ page }) => {
    await gotoReceptionistCenter(page, fx.slug);
    const pill = page.getByTestId("status-pill");
    await expect(pill).toHaveAttribute("data-state", "calm");
  });
});
