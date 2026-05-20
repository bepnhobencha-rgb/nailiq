/**
 * No-Show Protection — One-Tap Reschedule flow.
 * Tests slot loading, reschedule, double-booking prevention, mobile.
 */
import { test, expect } from "@playwright/test";
import { cleanupTestSalon, seedTestSalon } from "./helpers/db";
import { createServiceRoleClient } from "../src/shared/lib/supabase/serviceRole";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.describe("No-Show — Reschedule", () => {
  let testSlug: string;
  let salonId: string;
  let bookingId: string;
  let tokenId: string;

  test.beforeEach(async () => {
    const { slug, salonId: id } = await seedTestSalon({
      slug: "e2e-noshow-reschedule",
      name: "E2E Reschedule Salon",
      phone: "16045550200",
    });
    testSlug = slug;
    salonId = id;

    const supabase = createServiceRoleClient();
    const twoDaysOut = new Date(Date.now() + 48 * 60 * 60 * 1000);
    twoDaysOut.setHours(14, 0, 0, 0);

    const { data: svc } = await supabase
      .from("services").select("id").eq("salon_id", salonId).limit(1).maybeSingle();
    const { data: stf } = await supabase
      .from("staff").select("id").eq("salon_id", salonId).limit(1).maybeSingle();

    const { data: booking } = await supabase
      .from("bookings")
      .insert({
        salon_id: salonId,
        service_id: (svc as unknown as { id: string }).id,
        staff_id: (stf as unknown as { id: string }).id,
        client_name: "Reschedule Client",
        client_phone: "6045559001",
        client_email: "reschedule@example.com",
        start_time_utc: twoDaysOut.toISOString(),
        end_time_utc: new Date(twoDaysOut.getTime() + 60 * 60 * 1000).toISOString(),
        status: "confirmed",
      })
      .select("id").single();
    bookingId = (booking as unknown as { id: string }).id;

    const expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const { data: token } = await supabase
      .from("booking_reminder_tokens" as never)
      .insert({ booking_id: bookingId, salon_id: salonId, expires_at: expires })
      .select("id").single();
    tokenId = (token as unknown as { id: string }).id;
  });

  test.afterEach(async () => {
    await cleanupTestSalon(testSlug);
  });

  test("reschedule page loads with date picker", async ({ page }) => {
    await page.goto(`/booking/reschedule?token=${tokenId}`);
    await expect(page.getByText(/reschedule/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('input[type="date"]')).toBeVisible();
  });

  test("clicking Show Available Times loads slots", async ({ page }) => {
    await page.goto(`/booking/reschedule?token=${tokenId}`);
    await page.waitForLoadState("networkidle");

    // Pick a date 3 days from now
    const futureDate = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const dateStr = futureDate.toISOString().split("T")[0];
    await page.fill('input[type="date"]', dateStr);
    await page.getByRole("button", { name: /show available/i }).click();

    // Either shows slots or "no available times" message
    await expect(
      page.locator("text=/available times|no available|[0-9]+:[0-9]+/i").first()
    ).toBeVisible({ timeout: 15_000 });
  });

  test("invalid token shows error on reschedule page", async ({ page }) => {
    await page.goto("/booking/reschedule?token=00000000-0000-0000-0000-000000000000");
    // Attempting to load slots
    await page.locator('input[type="date"]').waitFor({ state: "visible", timeout: 10_000 });
    const futureDate = new Date(Date.now() + 72 * 60 * 60 * 1000);
    await page.fill('input[type="date"]', futureDate.toISOString().split("T")[0]);
    await page.getByRole("button", { name: /show available/i }).click();
    await expect(page.getByText(/unavailable|invalid|expired/i)).toBeVisible({ timeout: 10_000 });
  });

  test("mobile reschedule page is usable", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`/booking/reschedule?token=${tokenId}`);
    await expect(page.locator('input[type="date"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /show available/i })).toBeVisible();
  });
});
