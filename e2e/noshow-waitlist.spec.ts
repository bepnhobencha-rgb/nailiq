/**
 * No-Show Protection — Waitlist Auto-Fill.
 * Tests: notified entry after cancel, first-claim-wins, claim page UI.
 */
import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { cleanupTestSalon, mintBookingActionCapability, seedTestSalon } from "./helpers/db";
import { createServiceRoleClient } from "../src/shared/lib/supabase/serviceRole";

const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.describe("No-Show — Waitlist Auto-Fill", () => {
  let testSlug: string;
  let salonId: string;
  let bookingId: string;
  let cancelTokenId: string;
  let serviceId: string;
  let waitlistEntryId: string;
  const appOrigin = new URL(process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000").origin;

  async function cancelBooking(page: Page): Promise<void> {
    const res = await page.request.post("/api/booking/cancel-action", {
      data: { token: cancelTokenId, requestId: randomUUID() },
      headers: { Origin: appOrigin },
    });
    const json = (await res.json()) as { ok?: boolean; code?: string };
    expect(json, `cancel-action returned ${res.status()}`).toMatchObject({ ok: true });
  }

  async function activeClaimCapability(): Promise<string> {
    const supabase = createServiceRoleClient();
    const { data, error } = await supabase
      .from("waitlist_claim_capabilities" as never)
      .select("id")
      .eq("salon_id", salonId)
      .eq("waitlist_entry_id", waitlistEntryId)
      .is("revoked_at", null)
      .maybeSingle();
    if (error || !(data as { id?: string } | null)?.id) {
      throw new Error(error?.message ?? "active waitlist claim capability missing");
    }
    return (data as unknown as { id: string }).id;
  }

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

    cancelTokenId = await mintBookingActionCapability({
      salonId,
      bookingId,
      action: "cancel",
    });

    // Seed a legitimate waitlist entry for the exact occupied staff/slot. The
    // production guard rejects broad day-level waitlist fixtures when another
    // technician or time remains available.
    const { data: waitlistEntry, error: waitlistError } = await supabase
      .from("booking_waitlist_entries" as never)
      .insert({
        salon_id: salonId,
        service_id: serviceId,
        staff_id: (stf as unknown as { id: string }).id,
        booking_date: tomorrow.toISOString().split("T")[0],
        preferred_slot_label: "10:00 AM",
        client_name: "Waitlist Person",
        client_phone: "6045559003",
        client_email: "waitlist@example.com",
        source: "slot_unavailable",
        status: "waiting",
      })
      .select("id")
      .single();
    if (waitlistError || !(waitlistEntry as { id?: string } | null)?.id) {
      throw new Error(waitlistError?.message ?? "waitlist fixture insert failed");
    }
    waitlistEntryId = (waitlistEntry as unknown as { id: string }).id;
  });

  test.afterEach(async () => {
    await cleanupTestSalon(testSlug);
  });

  test("cancelling a booking marks the waitlist entry as notified", async ({ page }) => {
    // Cancel via the API (same as cancel page does)
    await cancelBooking(page);

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
    expect(await activeClaimCapability()).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("first waitlist claim wins", async ({ page }) => {
    // Cancel the booking to trigger waitlist notification
    await cancelBooking(page);
    const claimToken = await activeClaimCapability();

    // First claim
    await page.goto(`/booking/waitlist-claim?token=${claimToken}`);
    await page.getByRole("button", { name: /claim this spot/i }).click();
    await expect(page.getByRole("heading", { name: /confirmed/i })).toBeVisible({ timeout: 10_000 });

    // Verify DB state
    const supabase = createServiceRoleClient();
    const { data: updated } = await supabase
      .from("booking_waitlist_entries" as never)
      .select("status")
      .eq("salon_id", salonId)
      .maybeSingle();
    expect((updated as unknown as { status: string }).status).toBe("claimed");
  });

  test("second claim attempt shows slot unavailable", async ({ page }) => {
    // Cancel booking
    await cancelBooking(page);
    const claimToken = await activeClaimCapability();

    // First claim — succeeds
    await page.goto(`/booking/waitlist-claim?token=${claimToken}`);
    await page.getByRole("button", { name: /claim this spot/i }).click();
    await expect(page.getByRole("heading", { name: /confirmed/i })).toBeVisible({ timeout: 10_000 });

    // Second attempt through the same public boundary loses without exposing lifecycle details.
    const secondClaim = await page.request.post("/api/booking/waitlist-claim", {
      data: { token: claimToken, requestId: randomUUID() },
      headers: { Origin: appOrigin },
    });
    expect(secondClaim.status()).toBe(409);
    await expect(secondClaim.json()).resolves.toMatchObject({ ok: false, reason: "unavailable" });
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
    await cancelBooking(page);
    const claimToken = await activeClaimCapability();

    await page.goto(`/booking/waitlist-claim?token=${claimToken}`);
    await page.getByRole("button", { name: /claim this spot/i }).click();
    await expect(page.getByRole("heading", { name: /confirmed/i })).toBeVisible({ timeout: 10_000 });
  });
});
