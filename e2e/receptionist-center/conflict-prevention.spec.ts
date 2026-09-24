import { test, expect } from "@playwright/test";

import { cleanupTestSalon, cleanupTestUser, seedTestSalonMember } from "../helpers/db";
import { loginReceptionist } from "./realReceptionist";
import {
  cleanReceptionistData,
  clickAssignSlotAtUtc,
  clickWalkinService,
  clickWalkinSubmit,
  fillWalkinGuestContact,
  gotoReceptionistCenter,
  rcSlug,
  seedReceptionistCenterFixture,
  testClientNameMarker,
  type ReceptionistCenterFixture,
} from "./helpers";

let fx: ReceptionistCenterFixture;
let receptionist: Awaited<ReturnType<typeof seedTestSalonMember>>;

test.beforeAll(async ({}, testInfo) => {
  fx = await seedReceptionistCenterFixture(rcSlug(testInfo.project.name));
  receptionist = await seedTestSalonMember(fx.salonId, "receptionist");
});

test.beforeEach(async ({ page }) => {
  await cleanReceptionistData(fx.salonId);
  await loginReceptionist(page, receptionist);
});

test.afterAll(async ({}, testInfo) => {
  try { if (receptionist) await cleanupTestUser(receptionist.userId); }
  finally { await cleanupTestSalon(rcSlug(testInfo.project.name)); }
});

test.describe("Assign conflict prevention", () => {
  test("case 12: conflict slot shows desk message and keeps walk-in in queue", async ({
    page,
  }) => {
    await gotoReceptionistCenter(page, fx.slug, { useDemoCookie: false });
    const marker = testClientNameMarker();

    await fillWalkinGuestContact(page, marker);
    await clickWalkinService(page, fx.serviceIds[0]!);
    await clickWalkinSubmit(page);

    const row = page.locator(`[data-testid^="queue-item-"]`).filter({ hasText: marker });
    await expect(row).toBeVisible({ timeout: 15_000 });
    const tid = await row.getAttribute("data-testid");
    const bookingId = tid?.replace(/^queue-item-/, "") ?? "";

    await page.getByTestId(`queue-assign-${bookingId}`).click();

    await clickAssignSlotAtUtc(page, fx.conflictStaffId, fx.conflictSlotUtc);

    await expect(page.getByTestId(`queue-item-${bookingId}`)).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId(`booking-block-${bookingId}`)).toHaveCount(0);
    await expect(page.getByTestId("desk-action-message")).toBeVisible({ timeout: 8000 });
  });
});
