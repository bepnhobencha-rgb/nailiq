import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import {
  cleanupClientProfile,
  cleanupTestSalon,
  gotoBookingServiceStep,
  seedTestSalon,
} from "./helpers/db";
import {
  advanceBookingStep,
  selectAvailableBookingDate,
} from "./helpers/bookingFlow";

const SLUG = "e2e-shift-realtime";
const GUEST_PHONE_DIGITS = "16045550951";
const SHIFT_REFRESH_SLA_MS = 5_000;
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const anonDb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { persistSession: false } },
);

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function dayKeyFromYmd(ymd: string): (typeof DAY_KEYS)[number] {
  return DAY_KEYS[new Date(`${ymd}T12:00:00Z`).getUTCDay()]!;
}

test.describe("MQA-0051 — staff shift changes refresh public availability", () => {
  test.beforeEach(async () => {
    await cleanupClientProfile(GUEST_PHONE_DIGITS);
    await seedTestSalon({
      slug: SLUG,
      name: "E2E Shift Realtime Salon",
      phone: "15553334444",
    });
  });

  test.afterEach(async () => {
    await cleanupTestSalon(SLUG);
    await cleanupClientProfile(GUEST_PHONE_DIGITS);
  });

  test("owner shift edit invalidates an already-open guest slot within 5 seconds", async ({
    browser,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "chromium",
      "The independent owner/guest Realtime contract is measured once in Chromium",
    );

    const { data: salon, error: salonError } = await db
      .from("salons")
      .select("id")
      .eq("slug", SLUG)
      .single();
    expect(salonError).toBeNull();
    const salonId = salon!.id as string;

    const { data: staff, error: staffError } = await db
      .from("staff")
      .select("id")
      .eq("salon_id", salonId)
      .eq("status", "active")
      .single();
    expect(staffError).toBeNull();
    const staffId = staff!.id as string;

    const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
    const guestContext = await browser.newContext({ baseURL });
    const ownerContext = await browser.newContext({ baseURL });
    const guestPage = await guestContext.newPage();
    const ownerPage = await ownerContext.newPage();

    try {
      await ownerContext.addCookies([
        { name: "nailiq-demo-slug", value: SLUG, url: baseURL },
      ]);

      await gotoBookingServiceStep(guestPage, SLUG, {
        phone: GUEST_PHONE_DIGITS,
        name: "Shift Realtime Guest",
      });

      const serviceStep = guestPage.locator(
        'section[aria-labelledby="svc-heading"]',
      );
      await serviceStep.locator('[data-testid="service-tile-select"]').first().click();
      await advanceBookingStep(
        serviceStep,
        guestPage.locator('section[aria-labelledby="staff-heading"]'),
      );

      const staffStep = guestPage.locator(
        'section[aria-labelledby="staff-heading"]',
      );
      await staffStep.locator('[data-testid="staff-item"]').first().click();
      await advanceBookingStep(
        staffStep,
        guestPage.locator('section[aria-labelledby="date-heading"]'),
      );

      const selectedDateYmd = await selectAvailableBookingDate(guestPage);
      const selectedDayKey = dayKeyFromYmd(selectedDateYmd);
      const dateStep = guestPage.locator(
        'section[aria-labelledby="date-heading"]',
      );
      await advanceBookingStep(
        dateStep,
        guestPage.locator('section[aria-labelledby="time-heading"]'),
      );

      const timeStep = guestPage.locator(
        'section[aria-labelledby="time-heading"]',
      );
      await expect(timeStep).toHaveAttribute(
        "data-availability-realtime",
        "subscribed",
        { timeout: 15_000 },
      );

      const originalSlot = timeStep
        .locator('[data-testid="time-slot"]:not([disabled])')
        .first();
      await expect(originalSlot).toBeVisible();
      const originalSlotText = (await originalSlot.textContent())?.trim() ?? "";
      const originalTimeLabel = originalSlotText.match(/\d{1,2}:\d{2}\s[AP]M/)?.[0];
      expect(originalTimeLabel).toBeTruthy();
      await originalSlot.click();
      await expect(originalSlot).toHaveAttribute("aria-pressed", "true");

      await ownerPage.goto(`/dashboard/${SLUG}/settings?section=integrations`);
      await expect(ownerPage.getByRole("heading", { name: "Staff Shifts" })).toBeVisible({
        timeout: 20_000,
      });
      await expect(ownerPage.getByTestId("staff-shift-grid")).toBeVisible();

      const cell = ownerPage.getByTestId(
        `staff-shift-cell-${staffId}-${selectedDayKey}`,
      );
      await cell.getByTitle("Add shift").click();
      await ownerPage
        .getByTestId(`staff-shift-start-${staffId}-${selectedDayKey}`)
        .fill("17:00");
      await ownerPage
        .getByTestId(`staff-shift-end-${staffId}-${selectedDayKey}`)
        .fill("18:00");

      const startedAt = Date.now();
      await ownerPage
        .getByTestId(`staff-shift-save-${staffId}-${selectedDayKey}`)
        .click();
      await expect(cell).toContainText("17:00", { timeout: 10_000 });
      await expect(cell).toContainText("18:00", { timeout: 10_000 });

      await expect(guestPage.getByTestId("booking-time-error")).toContainText(
        "This slot was just booked. Please pick another time.",
        { timeout: SHIFT_REFRESH_SLA_MS },
      );
      const latencyMs = Date.now() - startedAt;
      console.info(`[MQA-0051] shift_refresh_latency_ms=${latencyMs}`);
      await testInfo.attach("mqa-0051-shift-refresh-latency.json", {
        body: JSON.stringify({ latencyMs, slaMs: SHIFT_REFRESH_SLA_MS }),
        contentType: "application/json",
      });
      expect(latencyMs, "owner save to guest stale-slot invalidation latency").toBeLessThanOrEqual(
        SHIFT_REFRESH_SLA_MS,
      );

      await expect(
        timeStep.locator('[data-testid="time-slot"][aria-pressed="true"]'),
      ).toHaveCount(0);
      await expect
        .poll(async () =>
          timeStep
            .locator('[data-testid="time-slot"][data-available="true"]')
            .evaluateAll(
              (buttons, label) =>
                buttons.some((button) => button.textContent?.includes(label)),
              originalTimeLabel!,
            ),
        )
        .toBe(false);

      const [{ data: shiftRow, error: shiftError }, { data: revisionRow, error: revisionError }] =
        await Promise.all([
          db
            .from("staff_shifts")
            .select("staff_id, salon_id, day_of_week, start_time, end_time, is_active")
            .eq("staff_id", staffId)
            .eq("day_of_week", selectedDayKey)
            .single(),
          db
            .from("salon_availability_revisions")
            .select("revision")
            .eq("salon_id", salonId)
            .single(),
        ]);
      expect(shiftError).toBeNull();
      expect(revisionError).toBeNull();
      expect(shiftRow).toMatchObject({
        staff_id: staffId,
        day_of_week: selectedDayKey,
        start_time: "17:00",
        end_time: "18:00",
        is_active: true,
      });
      expect(Number(revisionRow?.revision)).toBeGreaterThanOrEqual(1);

      const deniedAnonWrite = await anonDb
        .from("salon_availability_revisions")
        .update({ revision: 9_999_999 })
        .eq("salon_id", salonId);
      expect(deniedAnonWrite.error?.code).toBe("42501");
    } finally {
      await guestContext.close();
      await ownerContext.close();
    }
  });
});
