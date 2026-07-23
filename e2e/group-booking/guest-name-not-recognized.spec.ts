import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { cleanupTestSalon, enterBookingPhone } from "../helpers/db";
import { seedGroupTestSalon } from "./helpers";

/**
 * Privacy (S1): the public phone gate must NEVER surface a stored name —
 * real OR a "Guest N"/"Khách N" placeholder — to anyone who simply types a
 * phone number. A recognized phone gets a GENERIC "Welcome back!" and no name
 * field at all (the gate hides it for recognized customers — BookingTypeSwitcher
 * `!entryCustomer`), so there is nothing that could leak the stored name. The
 * name is only ever revealed/collected after OTP verification, never at the gate.
 */

const SLUG = "e2e-guestname";
const POLLUTED_PHONE = "16045558881";
const REAL_PHONE = "16045558882";
// Placeholder profile BUT a real name on a past booking → fallback.
const FALLBACK_PHONE = "16045558884";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

test.describe("Gate — no stored name is surfaced pre-OTP (privacy S1)", () => {
  test.beforeAll(async () => {
    const fx = await seedGroupTestSalon(SLUG);
    await supabase.from("client_profiles").upsert(
      [
        { phone: POLLUTED_PHONE, name: "Guest 1", visit_count: 3 },
        { phone: REAL_PHONE, name: "Real Name", visit_count: 2 },
        // Profile name is a placeholder, but a past booking has a real name.
        { phone: FALLBACK_PHONE, name: "Khách 2", visit_count: 1 },
      ],
      { onConflict: "phone" },
    );
    await supabase.from("bookings").insert({
      salon_id: fx.salonId,
      service_id: fx.serviceIds[0],
      staff_id: fx.staffIds[0],
      client_name: "Linda Real",
      client_phone: FALLBACK_PHONE,
      start_time_utc: "2026-05-01T18:00:00Z",
      end_time_utc: "2026-05-01T19:00:00Z",
      status: "completed",
      source: "appointment",
    });
  });
  test.afterAll(async () => {
    await supabase
      .from("client_profiles")
      .delete()
      .in("phone", [POLLUTED_PHONE, REAL_PHONE, FALLBACK_PHONE]);
    await cleanupTestSalon(SLUG);
  });

  test('"Guest 1" placeholder profile → generic greeting, name never shown', async ({
    page,
  }) => {
    await page.goto(`/${SLUG}`);
    await expect(page.getByTestId("booking-phone-gate")).toBeVisible();

    // National number — the full E.164 would be sliced to a bogus area code
    // and the lookup would never fire.
    await enterBookingPhone(page, POLLUTED_PHONE);
    // Recognized generically; the "Guest 1" placeholder (like any stored name)
    // is never surfaced. The name input is hidden at the gate for a recognized
    // customer (BookingTypeSwitcher `!entryCustomer`), so there is no field that
    // could leak the stored name.
    const recognized = page.getByTestId("booking-entry-recognized");
    await expect(recognized).toBeVisible({ timeout: 10_000 });
    await expect(recognized).not.toContainText("Guest 1");
    await expect(page.getByTestId("booking-entry-name")).not.toBeVisible();
  });

  test("real-name profile → generic greeting, name withheld pre-OTP", async ({
    page,
  }) => {
    await page.goto(`/${SLUG}`);
    await enterBookingPhone(page, REAL_PHONE);
    const recognized = page.getByTestId("booking-entry-recognized");
    await expect(recognized).toBeVisible({ timeout: 10_000 });
    // The real stored name must NOT leak to a phone-only lookup — neither in the
    // greeting nor via a pre-filled name field (which is hidden for a recognized
    // customer at the gate).
    await expect(recognized).not.toContainText("Real Name");
    await expect(page.getByTestId("booking-entry-name")).not.toBeVisible();
  });

  test("profile with a past real name → still withheld at the gate", async ({
    page,
  }) => {
    await page.goto(`/${SLUG}`);
    await enterBookingPhone(page, FALLBACK_PHONE);
    // Neither the placeholder ("Khách 2") nor the real booking name
    // ("Linda Real") is surfaced — recognition stays generic, and the name
    // input is hidden at the gate so nothing can leak through a pre-fill.
    const recognized = page.getByTestId("booking-entry-recognized");
    await expect(recognized).toBeVisible({ timeout: 10_000 });
    await expect(recognized).not.toContainText("Linda Real");
    await expect(recognized).not.toContainText("Khách 2");
    await expect(page.getByTestId("booking-entry-name")).not.toBeVisible();
  });
});
