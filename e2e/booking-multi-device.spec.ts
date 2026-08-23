import { createHash } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { navigateToConfirmStep } from "./helpers/bookingFlow";
import {
  cleanupClientProfile,
  cleanupTestSalon,
  seedTestSalon,
} from "./helpers/db";

const SLUG = "e2e-multi-device-booking";
const GUEST_NAME = "Multi Device Guest";
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function isolateRateLimitIdentity(page: Page, identity: string) {
  const digest = createHash("sha256").update(identity).digest("hex");
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `2001:db8::${digest.slice(0, 4)}:${digest.slice(4, 8)}`,
  });
}

test.describe("MQA-0040 — same booking intent from independent device sessions", () => {
  test.beforeAll(async () => {
    await seedTestSalon({
      slug: SLUG,
      name: "E2E Multi Device Salon",
      phone: "15553334444",
    });
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
  });

  test("commits exactly one booking and gives the other session a truthful conflict", async ({
    browser,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium",
      "The independent-context race is measured once on Chromium",
    );

    const guestPhone = `160455${String(Date.now() % 100_000).padStart(5, "0")}`;
    await cleanupClientProfile(guestPhone);

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    const firstContext = await browser.newContext({ baseURL });
    const secondContext = await browser.newContext({ baseURL });
    const firstPage = await firstContext.newPage();
    const secondPage = await secondContext.newPage();

    try {
      await isolateRateLimitIdentity(firstPage, `${guestPhone}:device-a`);
      await isolateRateLimitIdentity(secondPage, `${guestPhone}:device-b`);

      const [firstIntent, secondIntent] = await Promise.all([
        navigateToConfirmStep(firstPage, SLUG, {
          name: GUEST_NAME,
          phone: guestPhone,
        }),
        navigateToConfirmStep(secondPage, SLUG, {
          name: GUEST_NAME,
          phone: guestPhone,
        }),
      ]);
      expect(firstIntent.selectedDateYmd).toBe(secondIntent.selectedDateYmd);
      expect(firstIntent.selectedSlotAriaLabel).toBe(
        secondIntent.selectedSlotAriaLabel,
      );

      await Promise.all([
        firstPage.getByTestId("confirm-booking-btn").click(),
        secondPage.getByTestId("confirm-booking-btn").click(),
      ]);

      const conflictCopy = "This slot was just booked. Please pick another time.";
      const firstSuccess = firstPage.getByTestId("booking-success");
      const secondSuccess = secondPage.getByTestId("booking-success");
      const firstConflict = firstPage.getByRole("alert").filter({
        hasText: conflictCopy,
      });
      const secondConflict = secondPage.getByRole("alert").filter({
        hasText: conflictCopy,
      });

      await expect(firstSuccess.or(firstConflict).first()).toBeVisible({
        timeout: 20_000,
      });
      await expect(secondSuccess.or(secondConflict).first()).toBeVisible({
        timeout: 20_000,
      });

      const successCount = Number(await firstSuccess.isVisible()) +
        Number(await secondSuccess.isVisible());
      const conflictCount = Number(await firstConflict.isVisible()) +
        Number(await secondConflict.isVisible());
      expect(successCount, "exactly one device must receive booking success").toBe(1);
      expect(conflictCount, "the losing device must receive a truthful slot conflict").toBe(1);

      const { data: salon, error: salonError } = await db
        .from("salons")
        .select("id")
        .eq("slug", SLUG)
        .single();
      expect(salonError).toBeNull();

      const { data: bookings, error: bookingError } = await db
        .from("bookings")
        .select("id, client_name, client_phone, status")
        .eq("salon_id", salon!.id)
        .eq("client_phone", guestPhone);
      expect(bookingError).toBeNull();
      expect(bookings).toHaveLength(1);
      expect(bookings?.[0]).toMatchObject({
        client_name: GUEST_NAME,
        client_phone: guestPhone,
      });
    } finally {
      await firstContext.close();
      await secondContext.close();
      await cleanupClientProfile(guestPhone);
    }
  });
});
