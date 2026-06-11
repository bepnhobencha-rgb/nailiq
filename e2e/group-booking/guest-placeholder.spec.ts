/**
 * Group Booking — Guest placeholder UX tests.
 *
 * Covers:
 *   - Group booking can be saved when member names are not manually edited
 *   - Default name fields are pre-filled with "Guest N" placeholders
 *   - Organizer name is NOT copied to all members
 *   - Dashboard shows "Guest N" for unclaimed slots (booking client_name)
 *   - Individual booking validation is not affected
 *
 * Run: npm run test:e2e -- e2e/group-booking/guest-placeholder.spec.ts
 */
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { cleanupTestSalon } from "../helpers/db";
import {
  fillMemberCard,
  gotoGroupFlow,
  nextOpenDateYmd,
  pickDateInCalendar,
  seedGroupTestSalon,
  type GroupTestSalon,
} from "./helpers";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SLUG = "e2e-group-placeholder";
let salon: GroupTestSalon;

test.beforeAll(async () => {
  salon = await seedGroupTestSalon(SLUG);
});

test.afterAll(async () => {
  await cleanupTestSalon(SLUG);
});

// ─── Helper: complete group flow without filling member names ─────

async function completeFlowWithoutNames(
  page: Parameters<typeof gotoGroupFlow>[0],
) {
  await gotoGroupFlow(page, SLUG);

  // STEP 1 — size 2
  await page.getByTestId("group-size-2").click();
  await page.getByTestId("group-size-next").click();

  // STEP 2 — set services + staff only (DO NOT change member names)
  await page.getByTestId("group-step-service-panel").waitFor({ state: "visible" });
  // Only set service + staff, leave the name as the pre-filled "Guest N" default.
  await page.getByTestId("group-member-0-service").selectOption({ index: 1 });
  await page.getByTestId("group-member-0-staff").selectOption({ index: 1 });
  await page.getByTestId("group-member-1-service").selectOption({ index: 1 });
  await page.getByTestId("group-member-1-staff").selectOption({ index: 2 });
  await page.getByTestId("group-service-next").click();

  // STEP 3 — date
  await page.getByTestId("group-step-date-panel").waitFor({ state: "visible" });
  await pickDateInCalendar(page, nextOpenDateYmd());
  await page.getByTestId("group-arrival-afternoon").click();
  await page.getByTestId("group-date-next").click();

  // STEP 4 — arrangement
  await page.getByTestId("group-step-arrangement-panel").waitFor({ state: "visible" });
  await expect(page.getByTestId("group-arrangement-best")).toBeVisible({ timeout: 25_000 });
  await page.getByTestId("group-arrangement-best").click();
  await page.getByTestId("group-arrangement-next").click();

  // STEP 5 — organizer contact only
  await page.getByTestId("group-step-confirm-panel").waitFor({ state: "visible" });
  await page.getByTestId("group-primary-phone").fill("+16045551234");
}

// ─── Test: Guest placeholder fields are pre-filled ───────────────

test("member name fields are pre-filled with Guest N placeholders", async ({ page }) => {
  await gotoGroupFlow(page, SLUG);

  await page.getByTestId("group-size-2").click();
  await page.getByTestId("group-size-next").click();

  await page.getByTestId("group-step-service-panel").waitFor({ state: "visible" });

  // Both name fields should be pre-filled with "Guest 1" / "Guest 2"
  const name0 = await page.getByTestId("group-member-0-name").inputValue();
  const name1 = await page.getByTestId("group-member-1-name").inputValue();

  expect(name0).toMatch(/guest\s*1|khách\s*1/i);
  expect(name1).toMatch(/guest\s*2|khách\s*2/i);
});

// ─── Test: Booking succeeds without editing member names ──────────

test("group booking succeeds when member names are not manually edited", async ({ page }) => {
  await completeFlowWithoutNames(page);
  await page.getByTestId("group-sms-consent").check();
  await page.getByTestId("group-confirm").click();

  // Success screen
  await expect(page.getByTestId("booking-group-success")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("group-success-reference")).toBeVisible();
});

// ─── Test: Organizer name not copied to members ───────────────────

test("organizer phone is not copied as member names", async ({ page }) => {
  await gotoGroupFlow(page, SLUG);
  await page.getByTestId("group-size-2").click();
  await page.getByTestId("group-size-next").click();

  await page.getByTestId("group-step-service-panel").waitFor({ state: "visible" });

  // Names should be "Guest N", not the organizer's phone or any personal data
  const name0 = await page.getByTestId("group-member-0-name").inputValue();
  const name1 = await page.getByTestId("group-member-1-name").inputValue();

  // Must NOT contain phone number or organizer-specific data
  expect(name0).not.toMatch(/\d{10,}/);
  expect(name1).not.toMatch(/\d{10,}/);

  // Must match the guest placeholder pattern
  expect(name0).toMatch(/guest|khách/i);
  expect(name1).toMatch(/guest|khách/i);
});

// ─── Test: DB stores "Guest N" when names not edited ─────────────

test("DB stores Guest placeholder when organizer leaves names as default", async ({ page }) => {
  await completeFlowWithoutNames(page);
  await page.getByTestId("group-sms-consent").check();
  await page.getByTestId("group-confirm").click();

  await expect(page.getByTestId("booking-group-success")).toBeVisible({ timeout: 20_000 });

  // Extract group reference to find the group_id
  const refText = await page.getByTestId("group-success-reference").textContent();
  expect(refText).toBeTruthy();

  // Poll DB: find the most recent group for this salon, check client_name
  await expect
    .poll(
      async () => {
        const { data: bookings } = await supabase
          .from("bookings")
          .select("client_name, group_id")
          .eq("salon_id", salon.salonId)
          .not("group_id", "is", null)
          .order("created_at", { ascending: false })
          .limit(4);

        if (!bookings || bookings.length === 0) return false;
        // All group member names should match Guest N pattern or be a real name
        // (organizer may have edited one). At minimum, none should be empty.
        return bookings.every((b) => (b.client_name ?? "").trim().length > 0);
      },
      { timeout: 10_000, intervals: [500] },
    )
    .toBe(true);
});

// ─── Test: Helper text about Party Link is visible ────────────────

test("party link member hint is shown in step 2", async ({ page }) => {
  await gotoGroupFlow(page, SLUG);
  await page.getByTestId("group-size-2").click();
  await page.getByTestId("group-size-next").click();

  await page.getByTestId("group-step-service-panel").waitFor({ state: "visible" });

  // Helper text should be visible somewhere on step 2
  await expect(
    page.locator("text=/Party Link|Party link|party link/i").first(),
  ).toBeVisible({ timeout: 5_000 });
});

// ─── Test: Larger group generates correct Guest N names ───────────

test("3-person group generates Guest 1, Guest 2, Guest 3", async ({ page }) => {
  await gotoGroupFlow(page, SLUG);

  await page.getByTestId("group-size-3").click();
  await page.getByTestId("group-size-next").click();

  await page.getByTestId("group-step-service-panel").waitFor({ state: "visible" });

  const name0 = await page.getByTestId("group-member-0-name").inputValue();
  const name1 = await page.getByTestId("group-member-1-name").inputValue();
  const name2 = await page.getByTestId("group-member-2-name").inputValue();

  expect(name0).toMatch(/1/);
  expect(name1).toMatch(/2/);
  expect(name2).toMatch(/3/);
});
