/**
 * E2E for PR #349 #1 — receptionist cancels an entire group/party in one tap.
 *
 * Seeds a 2-slot party, opens the receptionist "Groups" panel, runs the
 * two-step "Cancel party" confirm, then asserts:
 *   - every booking in the group flips to `cancelled` in the DB
 *   - the cancelled party drops off the strip (card removed after refresh)
 *
 * Mirrors party-panel-no-nested-button.spec.ts for seeding + teardown.
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
  openAttentionGroups,
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
  // party_link_claims FK on bookings — clear party data before salon teardown.
  await cleanupPartyData(fx.salonId);
});
test.afterAll(async ({}, testInfo) => {
  await cleanupTestSalon(rcSlug(testInfo.project.name));
});

test.describe("PartyCardPanel — cancel whole group", () => {
  test("cancels every booking in the party and drops the card off the strip", async ({
    page,
  }) => {
    // Pin to the staff with no baseline booking + split into two 60-min waves so
    // the seed never trips bookings_no_overlap regardless of CI wall-clock
    // (same rationale as the no-nested-button spec).
    const party = await seedPartyLink({
      salonId: fx.salonId,
      staffIds: [fx.freeStaffId],
      serviceIds: fx.serviceIds,
      slotCount: 2,
      wavePlan: [1, 2],
    });

    await gotoReceptionistCenter(page, fx.slug);
    await openAttentionGroups(page);

    const card = page.getByTestId(`party-card-${party.groupId}`);
    await expect(card).toBeVisible();

    // Step 1: "Cancel party" reveals the inline confirm (no cancel yet).
    await page.getByTestId(`party-card-cancel-${party.groupId}`).click();
    await expect(
      page.getByTestId(`party-card-cancel-confirm-${party.groupId}`),
    ).toBeVisible();
    expect(
      (await getGroupBookingStatuses(fx.salonId, party.groupId)).sort(),
    ).toEqual(["confirmed", "confirmed"]);

    // Step 2: confirm → bulk cancel runs, strip refreshes, card disappears.
    await page.getByTestId(`party-card-cancel-yes-${party.groupId}`).click();
    await expect(page.getByTestId("party-card-cancel-success")).toBeVisible();
    await expect(card).toBeHidden();

    // Every booking in the group is now cancelled.
    const statuses = await getGroupBookingStatuses(fx.salonId, party.groupId);
    expect(statuses.length).toBe(2);
    expect(statuses.every((s) => s === "cancelled")).toBe(true);
  });
});
