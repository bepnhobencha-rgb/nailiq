import { test, expect } from "./test";

import {
  cleanReceptionistData,
  gotoReceptionistCenter,
  seedWalkin,
  testClientNameMarker,
} from "./helpers";

test.beforeEach(async ({ rcFixture }) => {
  await cleanReceptionistData(rcFixture.salonId);
});

test.describe("Status pill", () => {
  test("case 9: busy state after four waiting walk-ins", async ({ page, rcFixture }) => {
    for (let i = 0; i < 4; i += 1) {
      await seedWalkin(rcFixture.salonId, {
        /** Prefix Te2eGuest so cleanReceptionistData clears rows between tests */
        clientName: `${testClientNameMarker()}pill${i}`,
        serviceId: rcFixture.serviceIds[0]!,
      });
    }

    await gotoReceptionistCenter(page, rcFixture.slug);

    const pill = page.getByTestId("status-pill");
    await expect(pill).toHaveAttribute("data-state", "busy");
    await expect(pill).toContainText(/\b4\b/);
  });

  test("calm state when queue empty", async ({ page, rcFixture }) => {
    await gotoReceptionistCenter(page, rcFixture.slug);
    const pill = page.getByTestId("status-pill");
    await expect(pill).toHaveAttribute("data-state", "calm");
  });
});
