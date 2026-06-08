import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { cleanupTestSalon } from "../helpers/db";
import {
  cleanReceptionistData,
  gotoOwnerDashboard,
  rcSlug,
  seedReceptionistCenterFixture,
  type ReceptionistCenterFixture,
} from "./helpers";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

let fx: ReceptionistCenterFixture;

test.beforeAll(async ({}, testInfo) => {
  fx = await seedReceptionistCenterFixture(rcSlug(testInfo.project.name));
});
test.beforeEach(async () => {
  await cleanReceptionistData(fx.salonId);
});
test.afterAll(async ({}, testInfo) => {
  await cleanupTestSalon(rcSlug(testInfo.project.name));
});

test.describe("Owner dashboard — seat-together 💕 badge", () => {
  test("a seat_together booking shows the couple badge on the owner dashboard", async ({
    page,
  }) => {
    // The fixture's reliably-rendered booking ("RC Display Appt") survives
    // cleanReceptionistData. Flag it as a couple/seat-together booking
    // (the public flow sets this via the RPC; here we set it directly to
    // isolate the badge) and confirm the owner dashboard surfaces 💕.
    const { error } = await supabase
      .from("bookings")
      .update({ seat_together: true })
      .eq("salon_id", fx.salonId)
      .eq("client_name", "RC Display Appt");
    expect(error).toBeNull();

    await gotoOwnerDashboard(page, fx.slug);

    await expect(page.getByText("RC Display Appt").first()).toBeVisible();
    await expect(
      page.locator('[data-testid*="seat-together-"]').first(),
    ).toBeVisible();
  });
});
