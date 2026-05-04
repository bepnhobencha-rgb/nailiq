import { test, expect } from "@playwright/test";

import { salonToday, salonWallTimeToUtcIso } from "@/shared/lib/salonTime";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  gotoOwnerDashboard,
  RECEPTIONIST_E2E_SLUG,
  seedDeskBooking,
  seedReceptionistCenterFixture,
  seedWalkin,
  testClientNameMarker,
  type ReceptionistCenterFixture,
} from "./helpers";

/** Must match `timezoneId` in `playwright.config.ts` — owner stats use browser-local calendar day. */
const PLAYWRIGHT_CALENDAR_TZ = "America/Los_Angeles";

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

    const browserYmd = salonToday(PLAYWRIGHT_CALENDAR_TZ);
    const completedStartIso = salonWallTimeToUtcIso(browserYmd, 9 * 60 + 30, PLAYWRIGHT_CALENDAR_TZ);
    const completedEndIso = salonWallTimeToUtcIso(browserYmd, 10 * 60 + 25, PLAYWRIGHT_CALENDAR_TZ);
    await seedDeskBooking(fx.salonId, {
      clientName: `${marker}_completed_stat`,
      serviceId: fx.serviceIds[0]!,
      staffId: fx.freeStaffId,
      startIso: completedStartIso,
      endIso: completedEndIso,
      status: "completed",
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
