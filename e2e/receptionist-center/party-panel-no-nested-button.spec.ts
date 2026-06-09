/**
 * Regression guard for React #418 (hydration mismatch) on the receptionist
 * dashboard. Two invalid-HTML / server-client-branch sources were fixed:
 *
 *  1. PartyCardPanel rendered the Refresh <button> INSIDE the collapse-toggle
 *     <button>. Nested buttons are invalid HTML; the browser un-nests them on
 *     the client, diverging from the SSR markup → #418 on every load.
 *  2. The walk-in wait-link button was gated on `window.location.origin`
 *     computed during render (empty on server, set on client) → #418 whenever
 *     a walk-in was queued. (Covered by the existing queue spec; this file
 *     pins the structural party-panel invariant.)
 *
 * This asserts the structural invariant directly: the refresh control must be
 * a SIBLING of the toggle, never a descendant.
 */
import { test, expect } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import { cleanupPartyData, seedPartyLink } from "../party-booking/helpers";
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
test.afterEach(async () => {
  // party_link_claims FK on bookings — clear party data so afterAll teardown
  // (cleanupTestSalon) doesn't trip the constraint.
  await cleanupPartyData(fx.salonId);
});
test.afterAll(async ({}, testInfo) => {
  await cleanupTestSalon(rcSlug(testInfo.project.name));
});

test.describe("PartyCardPanel — valid HTML (no nested buttons)", () => {
  test("refresh button is NOT a descendant of the toggle button", async ({
    page,
  }) => {
    // The PartyCardPanel now lives inside the AttentionChipBar "Groups"
    // dropdown, which only appears when the salon has an active party. Seed
    // one, then open the dropdown to reach the panel.
    await seedPartyLink({
      salonId: fx.salonId,
      staffIds: fx.staffIds,
      serviceIds: fx.serviceIds,
      slotCount: 2,
    });

    await gotoReceptionistCenter(page, fx.slug);
    await page.getByTestId("attention-chip-groups").click();

    const toggle = page.getByTestId("party-card-panel-toggle");
    const refresh = page.getByTestId("party-card-panel-refresh");
    await expect(toggle).toBeVisible();
    await expect(refresh).toBeVisible();

    // The refresh control must not live inside the toggle button (invalid HTML).
    const refreshInsideToggle = await toggle.evaluate(
      (toggleEl, refreshSel) => !!toggleEl.querySelector(refreshSel),
      '[data-testid="party-card-panel-refresh"]',
    );
    expect(refreshInsideToggle).toBe(false);

    // Both must be real <button> elements (accessible), just not nested.
    await expect(toggle).toHaveJSProperty("tagName", "BUTTON");
    await expect(refresh).toHaveJSProperty("tagName", "BUTTON");

    // Refresh must NOT toggle the collapse (it's a sibling now — no bubbling).
    const before = await toggle.getAttribute("aria-expanded");
    await refresh.click();
    await expect(toggle).toHaveAttribute("aria-expanded", before ?? "false");

    // Toggle still flips the panel after hydration.
    await toggle.click();
    await expect(toggle).toHaveAttribute(
      "aria-expanded",
      before === "true" ? "false" : "true",
    );
  });
});
