import { expect, test } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  fillMemberCard,
  gotoGroupFlow,
  nextOpenDateYmd,
  pickDateInCalendar,
  seedGroupTestSalon,
} from "./helpers";

/**
 * Part B — "tap your name" Party Link claim page.
 *
 * When the organizer typed a real name for a guest, that guest opens
 * the share link, taps "This is me", and the claim form is already
 * pre-filled with their name — they just confirm (phone optional).
 *
 * With organizer pre-claim (default on), the organizer's own slot is
 * already confirmed, so the only claimable slot is the other guest's.
 */

const SLUG = "e2e-claim-tapname";

test.describe("Party Link — tap your name", () => {
  test.beforeAll(async () => {
    await seedGroupTestSalon(SLUG);
  });
  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
  });

  test("claim form pre-fills the organizer-typed guest name", async ({
    page,
    context,
  }) => {
    await gotoGroupFlow(page, SLUG);
    await page.getByTestId("group-size-2").click();
    await page.getByTestId("group-size-next").click();
    await page
      .getByTestId("group-step-service-panel")
      .waitFor({ state: "visible" });
    // Organizer = Mai (Guest 1); Guest 2 named "Lan".
    await fillMemberCard(page, 0, "Mai", 1, 1);
    await fillMemberCard(page, 1, "Lan", 1, 2);
    await page.getByTestId("group-service-next").click();

    await page.getByTestId("group-step-date-panel").waitFor({ state: "visible" });
    await pickDateInCalendar(page, nextOpenDateYmd());
    await page.getByTestId("group-arrival-afternoon").click();
    await page.getByTestId("group-date-next").click();

    await page
      .getByTestId("group-step-arrangement-panel")
      .waitFor({ state: "visible" });
    const best = page.getByTestId("group-arrangement-best");
    await expect(best).toBeVisible({ timeout: 20_000 });
    await best.click();
    await page.getByTestId("group-arrangement-next").click();

    await page
      .getByTestId("group-step-confirm-panel")
      .waitFor({ state: "visible" });
    await page.getByTestId("group-primary-phone").fill("+16045551234");
    await page.getByTestId("group-confirm").click();
    await expect(page.getByTestId("booking-group-success")).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByTestId("party-link-share")).toBeVisible({
      timeout: 30_000,
    });
    const url = await page.getByTestId("party-link-url").inputValue();
    expect(url).toContain("/party/");

    // Open the share link as a guest.
    const guest = await context.newPage();
    await guest.goto(url);
    await guest
      .locator('[data-testid^="party-slot-card-"]')
      .first()
      .waitFor({ state: "visible" });

    // Only the un-claimed slot ("Lan") offers a claim button; tap it.
    const claimBtn = guest.getByTestId("party-claim-btn").first();
    await expect(claimBtn).toBeVisible();
    await claimBtn.click();

    // The name is already filled in — the guest just confirms.
    await expect(guest.getByTestId("party-claim-name")).toHaveValue("Lan");
    await guest.close();
  });
});
