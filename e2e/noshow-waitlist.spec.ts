/**
 * No-Show Protection — Waitlist Auto-Fill.
 * Tests: notified entry after cancel, first-claim-wins, claim page UI.
 */
import { test, expect } from "@playwright/test";
import { cleanupTestSalon, seedTestSalon } from "./helpers/db";
import { createServiceRoleClient } from "../src/shared/lib/supabase/serviceRole";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.describe("No-Show — Waitlist Auto-Fill", () => {
  let testSlug: string;
  let salonId: string;
  let bookingId: string;
  let cancelTokenId: string;
  let serviceId: string;

  test.beforeEach(async () => {
    const { slug, salonId: id } = await seedTestSalon({
      slug: "e2e-noshow-waitlist",
      name: "E2E Waitlist Salon",
      phone: "16045550300",
    });
    testSlug = slug;
    salonId = id;

    const supabase = createServiceRoleClient();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    tomorrow.setHours(10, 0, 0, 0);

    const { data: svc } = await supabase
      .from("services").select("id").eq("salon_id", salonId).limit(1).maybeSingle();
    const { data: stf } = await supabase
      .from("staff").select("id").eq("salon_id", salonId).limit(1).maybeSingle();

    serviceId = (svc as unknown as { id: string }).id;

    // Seed a booking to cancel
    const { data: booking } = await supabase
      .from("bookings")
      .insert({
        salon_id: salonId,
        service_id: serviceId,
        staff_id: (stf as unknown as { id: string }).id,
        client_name: "Cancel Client",
        client_phone: "6045559002",
        start_time_utc: tomorrow.toISOString(),
        end_time_utc: new Date(tomorrow.getTime() + 60 * 60 * 1000).toISOString(),
        status: "confirmed",
      })
      .select("id").single();
    bookingId = (booking as unknown as { id: string }).id;

    // Seed a cancel token
    const expires = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const { data: token } = await supabase
      .from("booking_reminder_tokens" as never)
      .insert({ booking_id: bookingId, salon_id: salonId, expires_at: expires })
      .select("id").single();
    cancelTokenId = (token as unknown as { id: string }).id;

    // Seed a waitlist entry for the same service + date
    await supabase
      .from("booking_waitlist_entries" as never)
      .insert({
        salon_id: salonId,
        service_id: serviceId,
        booking_date: tomorrow.toISOString().split("T")[0],
        client_name: "Waitlist Person",
        client_phone: "6045559003",
        client_email: "waitlist@example.com",
        source: "slot_unavailable",
        status: "waiting",
      });
  });

  test.afterEach(async () => {
    await cleanupTestSalon(testSlug);
  });

  test("cancelling a booking marks the waitlist entry as notified", async ({ page }) => {
    // Cancel via the API (same as cancel page does)
    const res = await page.request.post("/api/booking/cancel-action", {
      data: { token: cancelTokenId },
    });
    const json = (await res.json()) as { ok?: boolean };
    expect(json.ok).toBe(true);

    // Check the waitlist entry is now 'notified'
    const supabase = createServiceRoleClient();
    const { data } = await supabase
      .from("booking_waitlist_entries" as never)
      .select("status, claim_token")
      .eq("salon_id", salonId)
      .eq("service_id", serviceId)
      .maybeSingle();

    const row = data as { status: string; claim_token: string | null } | null;
    expect(row?.status).toBe("notified");
    expect(row?.claim_token).not.toBeNull();
  });

  test("first waitlist claim wins", async ({ page }) => {
    // Cancel the booking to trigger waitlist notification
    await page.request.post("/api/booking/cancel-action", {
      data: { token: cancelTokenId },
    });

    const supabase = createServiceRoleClient();
    const { data } = await supabase
      .from("booking_waitlist_entries" as never)
      .select("claim_token")
      .eq("salon_id", salonId)
      .maybeSingle();
    const row = data as { claim_token: string } | null;
    expect(row?.claim_token).toBeTruthy();

    // First claim
    await page.goto(`/booking/waitlist-claim?token=${row!.claim_token}`);
    await expect(page.getByText(/spot claimed/i)).toBeVisible({ timeout: 10_000 });

    // Verify DB state
    const { data: updated } = await supabase
      .from("booking_waitlist_entries" as never)
      .select("status")
      .eq("salon_id", salonId)
      .maybeSingle();
    expect((updated as unknown as { status: string }).status).toBe("claimed");
  });

  test("second claim attempt shows slot unavailable", async ({ page }) => {
    // Cancel booking
    await page.request.post("/api/booking/cancel-action", {
      data: { token: cancelTokenId },
    });

    const supabase = createServiceRoleClient();
    const { data } = await supabase
      .from("booking_waitlist_entries" as never)
      .select("claim_token")
      .eq("salon_id", salonId)
      .maybeSingle();
    const claimToken = (data as unknown as { claim_token: string }).claim_token;

    // First claim — succeeds
    await page.goto(`/booking/waitlist-claim?token=${claimToken}`);
    await page.waitForLoadState("networkidle");

    // Second attempt via direct RPC
    const { data: secondClaim } = await supabase.rpc("claim_waitlist_slot" as never, {
      p_claim_token: claimToken,
    });
    expect(Array.isArray(secondClaim) && secondClaim.length === 0).toBe(true);
  });

  test("invalid claim token shows slot unavailable page", async ({ page }) => {
    await page.goto("/booking/waitlist-claim?token=00000000-0000-0000-0000-000000000000");
    // The page renders both a heading and a detail paragraph that match the
    // regex; use .first() to target only the heading and avoid strict-mode violations.
    await expect(page.getByText(/unavailable|already been claimed|invalid/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("mobile claim page is usable", async ({ page }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.request.post("/api/booking/cancel-action", {
      data: { token: cancelTokenId },
    });

    const supabase = createServiceRoleClient();
    const { data } = await supabase
      .from("booking_waitlist_entries" as never)
      .select("claim_token")
      .eq("salon_id", salonId)
      .maybeSingle();
    const claimToken = (data as unknown as { claim_token: string }).claim_token;

    await page.goto(`/booking/waitlist-claim?token=${claimToken}`);
    await expect(page.getByText(/spot claimed|unavailable/i)).toBeVisible({ timeout: 10_000 });
  });
});
