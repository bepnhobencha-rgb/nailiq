/**
 * No-Show Protection — One-Tap Confirm flow.
 * Tests confirm / already-used token / missing token scenarios.
 */
import { test, expect } from "@playwright/test";
import { cleanupTestSalon, mintBookingActionCapability, seedTestSalon } from "./helpers/db";
import { createServiceRoleClient } from "../src/shared/lib/supabase/serviceRole";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.describe("No-Show — One-Tap Confirm", () => {
  let testSlug: string;
  let salonId: string;
  let bookingId: string;
  let tokenId: string;

  test.beforeEach(async () => {
    const { slug, salonId: id } = await seedTestSalon({
      slug: "e2e-noshow-confirm",
      name: "E2E NoShow Salon",
      phone: "16045550100",
    });
    testSlug = slug;
    salonId = id;

    // Seed a booking
    const supabase = createServiceRoleClient();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const { data: svc } = await supabase
      .from("services")
      .select("id")
      .eq("salon_id", salonId)
      .limit(1)
      .maybeSingle();
    const { data: stf } = await supabase
      .from("staff")
      .select("id")
      .eq("salon_id", salonId)
      .limit(1)
      .maybeSingle();

    const { data: booking } = await supabase
      .from("bookings")
      .insert({
        salon_id: salonId,
        service_id: (svc as unknown as { id: string }).id,
        staff_id: (stf as unknown as { id: string }).id,
        client_name: "Test Client",
        client_phone: "6045559000",
        client_email: "test@example.com",
        start_time_utc: tomorrow,
        end_time_utc: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString(),
        status: "pending",
      })
      .select("id")
      .single();
    bookingId = (booking as unknown as { id: string }).id;

    tokenId = await mintBookingActionCapability({
      salonId,
      bookingId,
      action: "confirm",
    });
  });

  test.afterEach(async () => {
    await cleanupTestSalon(testSlug);
  });

  test("valid token confirms appointment", async ({ page }) => {
    await page.goto(`/booking/confirm?token=${tokenId}`);
    await page.getByRole("button", { name: /yes, confirm my appointment/i }).click();
    await expect(page.getByText(/appointment confirmed/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/confirmed/i).first()).toBeVisible();
  });

  test("used token shows error", async ({ page }) => {
    // Confirm once
    await page.goto(`/booking/confirm?token=${tokenId}`);
    await page.getByRole("button", { name: /yes, confirm my appointment/i }).click();
    await expect(page.getByText(/appointment confirmed/i)).toBeVisible({ timeout: 10_000 });

    // A consumed capability is not proof of the appointment's current status.
    // Explain recovery without offering another confirmation or claiming success.
    await page.goto(`/booking/confirm?token=${tokenId}`);
    await expect(page.getByRole("heading", { name: "Link already used", exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("status")).toContainText("current status");
    await expect(page.getByRole("button", { name: /yes, confirm my appointment/i })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /appointment confirmed/i })).toHaveCount(0);
  });

  test("missing token shows error", async ({ page }) => {
    await page.goto("/booking/confirm");
    await expect(page.getByRole("heading", { name: "Check your appointment link", exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("status")).toContainText("complete link");
    await expect(page.getByRole("button", { name: /yes, confirm my appointment/i })).toHaveCount(0);
  });

  test("mobile confirm flow", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`/booking/confirm?token=${tokenId}`);
    await page.getByRole("button", { name: /yes, confirm my appointment/i }).click();
    await expect(page.getByText(/appointment confirmed/i)).toBeVisible({ timeout: 10_000 });
  });
});
