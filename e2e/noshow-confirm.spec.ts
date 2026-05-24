/**
 * No-Show Protection — One-Tap Confirm flow.
 * Tests confirm / already-used token / missing token scenarios.
 */
import { test, expect } from "@playwright/test";
import { cleanupTestSalon, seedTestSalon } from "./helpers/db";
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

    // Create reminder token
    const expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const { data: token } = await supabase
      .from("booking_reminder_tokens" as never)
      .insert({ booking_id: bookingId, salon_id: salonId, expires_at: expires })
      .select("id")
      .single();
    tokenId = (token as unknown as { id: string }).id;
  });

  test.afterEach(async () => {
    await cleanupTestSalon(testSlug);
  });

  test("valid token confirms appointment", async ({ page }) => {
    await page.goto(`/booking/confirm?token=${tokenId}`);
    await expect(page.getByText(/appointment confirmed/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/confirmed/i).first()).toBeVisible();
  });

  test("used token shows error", async ({ page }) => {
    // Confirm once
    await page.goto(`/booking/confirm?token=${tokenId}`);
    await page.waitForLoadState("networkidle");

    // Try again — token is now used, page renders "Link Unavailable" heading +
    // an error message. Use the h1 heading as the anchor to avoid strict-mode
    // violations when multiple elements contain the same substring.
    await page.goto(`/booking/confirm?token=${tokenId}`);
    await expect(page.getByRole("heading", { name: /link unavailable/i }).first()).toBeVisible({ timeout: 10_000 });
  });

  test("missing token shows error", async ({ page }) => {
    await page.goto("/booking/confirm");
    // "Link Unavailable" h1 is the authoritative signal — avoids strict-mode
    // violations from matching both the heading and the detail paragraph.
    await expect(page.getByRole("heading", { name: /link unavailable/i }).first()).toBeVisible({ timeout: 10_000 });
  });

  test("mobile confirm flow", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`/booking/confirm?token=${tokenId}`);
    await expect(page.getByText(/appointment confirmed/i)).toBeVisible({ timeout: 10_000 });
  });
});
