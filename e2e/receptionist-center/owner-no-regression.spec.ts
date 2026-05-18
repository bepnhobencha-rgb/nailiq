import { test, expect } from "./test";

import { salonToday, salonWallTimeToUtcIso } from "@/shared/lib/salonTime";

import {
  cleanReceptionistData,
  gotoOwnerDashboard,
  seedDeskBooking,
  seedWalkin,
  testClientNameMarker,
} from "./helpers";

/** Must match `timezoneId` in `playwright.config.ts` — owner stats use browser-local calendar day. */
const PLAYWRIGHT_CALENDAR_TZ = "America/Los_Angeles";

test.beforeEach(async ({ rcFixture }) => {
  await cleanReceptionistData(rcFixture.salonId);
});

test.describe("Owner dashboard regression", () => {
  test("case 8: today agenda excludes waiting walk-ins; stats show completed", async ({ page, rcFixture }) => {
    const marker = testClientNameMarker();
    await seedWalkin(rcFixture.salonId, {
      clientName: marker,
      serviceId: rcFixture.serviceIds[0]!,
    });

    const browserYmd = salonToday(PLAYWRIGHT_CALENDAR_TZ);
    const completedStartIso = salonWallTimeToUtcIso(browserYmd, 9 * 60 + 30, PLAYWRIGHT_CALENDAR_TZ);
    const completedEndIso = salonWallTimeToUtcIso(browserYmd, 10 * 60 + 25, PLAYWRIGHT_CALENDAR_TZ);
    await seedDeskBooking(rcFixture.salonId, {
      clientName: `${marker}_completed_stat`,
      serviceId: rcFixture.serviceIds[0]!,
      staffId: rcFixture.freeStaffId,
      startIso: completedStartIso,
      endIso: completedEndIso,
      status: "completed",
    });

    await gotoOwnerDashboard(page, rcFixture.slug);

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
