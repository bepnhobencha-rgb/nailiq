/**
 * E2E — group-aware cancel from the booking drawer.
 *
 * Cancelling ONE member of a party used to silently cancel just that row with no
 * hint it was part of a group. Now the cancel modal detects the party and offers
 * "just this person" vs "whole party (N)". This seeds a 2-slot party, opens one
 * member's drawer, runs cancel, asserts the scope toggle appears (default = this
 * person), picks "whole party", and verifies every member flips to cancelled.
 *
 * Mirrors cancel-whole-party.spec.ts for seeding + teardown, but exercises the
 * DRAWER path (the per-member cancel) rather than the PartyCardPanel.
 */
import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanupPartyData,
  getGroupBookingStatuses,
  seedPartyLink,
} from "../party-booking/helpers";
import {
  cleanReceptionistData,
  gotoReceptionistCenter,
  isoAtUtcYmdHourMinute,
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
test.afterEach(async () => {
  await cleanupPartyData(fx.salonId);
});
test.afterAll(async ({}, testInfo) => {
  await cleanupTestSalon(rcSlug(testInfo.project.name));
});

test.describe("Drawer cancel — group-aware scope", () => {
  test("offers whole-party scope and cancels every member", async ({ page }) => {
    // Two members in separate 60-min waves so the seed never trips
    // bookings_no_overlap (same approach as cancel-whole-party.spec.ts).
    const party = await seedPartyLink({
      salonId: fx.salonId,
      staffIds: [fx.freeStaffId],
      serviceIds: fx.serviceIds,
      slotCount: 2,
      wavePlan: [1, 2],
      startTimeIso: isoAtUtcYmdHourMinute(fx.ymdUtc, 12, 0),
    });

    await gotoReceptionistCenter(page, fx.slug, { dateYmd: fx.ymdUtc });

    // Open the drawer for ONE member (synthetic click — drawer/grid blocks fail
    // Playwright's actionability gate under the open animation; the repo's other
    // drawer specs use the same evaluate-click trick).
    const memberId = party.bookingIds[0]!;
    await page
      .getByTestId(`booking-block-${memberId}`)
      .evaluate((el: HTMLElement) => el.click());
    await expect(page.getByTestId("booking-detail-drawer")).toBeVisible();

    await page
      .getByTestId("drawer-cancel-booking")
      .evaluate((el: HTMLElement) => el.click());

    // Group-aware scope chooser appears; default is "just this person".
    await expect(page.getByTestId("cancel-group-scope")).toBeVisible();
    await expect(page.getByTestId("drawer-cancel-booking")).toHaveCount(0);
    await expect(page.getByTestId("cancel-scope-this")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Switch to whole-party, confirm, and verify every member is cancelled.
    await page.getByTestId("cancel-scope-whole").click();
    await page
      .getByTestId("notify-cancel-confirm")
      .evaluate((el: HTMLElement) => el.click());
    await expect(page.getByTestId("desk-status-success")).toBeVisible();

    await expect
      .poll(
        async () => {
          const s = await getGroupBookingStatuses(fx.salonId, party.groupId);
          return s.length === 2 && s.every((x) => x === "cancelled");
        },
        { timeout: 15_000 },
      )
      .toBe(true);
  });
});
