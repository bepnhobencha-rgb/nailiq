import { expect, test } from "@playwright/test";

import { cleanupTestSalon, seedTestSalon } from "./helpers/db";
import { createServiceRoleClient } from "../src/shared/lib/supabase/serviceRole";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const SLUG = "e2e-archived-booking-detail";

test.describe("Archived booking detail — read-only history", () => {
  let salonId: string;

  test.beforeAll(async () => {
    const seeded = await seedTestSalon({
      slug: SLUG,
      name: "E2E Archived Booking Salon",
      phone: "16045551880",
      feature_flags: { archived_booking_recovery_enabled: false },
    });
    salonId = seeded.salonId;

    const db = createServiceRoleClient();
    const [{ data: service }, { data: staff }] = await Promise.all([
      db
        .from("services")
        .select("id")
        .eq("salon_id", salonId)
        .limit(1)
        .single(),
      db
        .from("staff")
        .select("id")
        .eq("salon_id", salonId)
        .limit(1)
        .single(),
    ]);

    const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
    start.setUTCHours(17, 0, 0, 0);
    const shared = {
      salon_id: salonId,
      service_id: service!.id,
      staff_id: staff!.id,
      start_time_utc: start.toISOString(),
      end_time_utc: new Date(start.getTime() + 45 * 60 * 1000).toISOString(),
      source: "appointment",
      booking_channel: "staff",
      price_cents: 4500,
    };

    const { error } = await db.from("bookings").insert([
      {
        ...shared,
        client_name: "Archived Cancelled Guest",
        client_phone: "16045551881",
        status: "cancelled",
      },
      {
        ...shared,
        client_name: "Archived No Show Guest",
        client_phone: "16045551882",
        status: "no_show",
        noshow_fee_cents: 1700,
        noshow_charge_status: "waived",
      },
    ]);
    if (error) throw new Error(error.message);
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
  });

  test.beforeEach(async ({ page }) => {
    await page.context().addCookies([
      { name: "nailiq-demo-slug", value: SLUG, url: BASE_URL },
    ]);
    await page.goto(`/dashboard/${SLUG}/activity`);
    await expect(
      page.getByRole("heading", { name: "Nhật ký hoạt động" }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("owner can inspect cancelled history while recovery stays off", async ({
    page,
  }) => {
    await page.getByTestId("activity-tab-cancelled").click();
    await page
      .getByTestId("activity-open-archived-booking")
      .filter({ hasText: "Archived Cancelled Guest" })
      .click();

    const detail = page.getByTestId("archived-booking-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("Archived Cancelled Guest");
    await expect(detail).toContainText("Đã huỷ");
    await expect(detail).not.toContainText("16045551881");
    await expect(page.getByTestId("archived-booking-recover")).toHaveCount(0);
  });

  test("owner can inspect no-show fee outcome without reopening it", async ({
    page,
  }) => {
    await page.getByTestId("activity-tab-no_show").click();
    await page
      .getByTestId("activity-open-archived-booking")
      .filter({ hasText: "Archived No Show Guest" })
      .click();

    const detail = page.getByTestId("archived-booking-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("Archived No Show Guest");
    await expect(detail).toContainText("Không đến");
    await expect(detail).toContainText("$17.00");
    await expect(detail).toContainText("Đã miễn phí");
    await expect(page.getByTestId("archived-booking-recover")).toHaveCount(0);
  });
});
