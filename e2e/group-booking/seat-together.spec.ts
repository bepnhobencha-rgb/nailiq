import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { cleanupTestSalon } from "../helpers/db";
import {
  fillMemberCard,
  gotoGroupFlow,
  nextOpenDateYmd,
  pickDateInCalendar,
  seedGroupTestSalon,
} from "./helpers";

/**
 * Group "seat together" / couple preference.
 *
 * Head-spa tenants have no dedicated couple room, but they place two
 * beds side by side and pull a curtain to make a couple space. The
 * group flow exposes a "seat us next to each other" toggle (default
 * ON); the preference is persisted on every member's booking row
 * (`bookings.seat_together`) so the receptionist board shows a 💕
 * badge and reception knows to set up adjacent beds.
 *
 * This spec proves the full chain: toggle default ON → confirm →
 * warm success copy → DB column written true; and toggle OFF →
 * column false.
 */

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, serviceKey);

async function seatTogetherFlagsForSalon(slug: string): Promise<boolean[]> {
  const { data: salon } = await supabase
    .from("salons")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (!salon) return [];
  const { data: rows } = await supabase
    .from("bookings")
    .select("seat_together")
    .eq("salon_id", salon.id);
  return (rows ?? []).map((r) => r.seat_together === true);
}

async function bookGroupOfTwo(
  page: import("@playwright/test").Page,
  slug: string,
  phone: string,
): Promise<void> {
  await gotoGroupFlow(page, slug);
  await page.getByTestId("group-size-2").click();
  await page.getByTestId("group-size-next").click();
  await page
    .getByTestId("group-step-service-panel")
    .waitFor({ state: "visible" });
  await fillMemberCard(page, 0, "Mai", 1, 1);
  await fillMemberCard(page, 1, "Linh", 1, 2);
  await page.getByTestId("group-service-next").click();

  await page.getByTestId("group-step-date-panel").waitFor({ state: "visible" });
  await pickDateInCalendar(page, nextOpenDateYmd());
  await page.getByTestId("group-arrival-afternoon").click();
  await page.getByTestId("group-date-next").click();

  await page
    .getByTestId("group-step-arrangement-panel")
    .waitFor({ state: "visible" });
  const bestCard = page.getByTestId("group-arrangement-best");
  await expect(bestCard).toBeVisible({ timeout: 20_000 });
  await bestCard.click();
  await page.getByTestId("group-arrangement-next").click();

  await page
    .getByTestId("group-step-confirm-panel")
    .waitFor({ state: "visible" });
  await page.getByTestId("group-primary-phone").fill(phone);
  await page.getByTestId("group-confirm").click();
  await expect(page.getByTestId("booking-group-success")).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("Group booking — seat together / couple", () => {
  test("toggle defaults ON, persists seat_together=true + shows warm success copy", async ({
    page,
  }) => {
    const SLUG = "e2e-group-seat-on";
    await seedGroupTestSalon(SLUG);
    try {
      // Toggle is visible and ON by default on step 2.
      await gotoGroupFlow(page, SLUG);
      await page.getByTestId("group-size-2").click();
      await page.getByTestId("group-size-next").click();
      await page
        .getByTestId("group-step-service-panel")
        .waitFor({ state: "visible" });
      await expect(page.getByTestId("group-seat-together")).toHaveAttribute(
        "aria-checked",
        "true",
      );
      // Restart the flow cleanly and book end-to-end with default ON.
      await bookGroupOfTwo(page, SLUG, "+16045550111");

      await expect(
        page.getByTestId("group-success-seat-together"),
      ).toBeVisible();

      const flags = await seatTogetherFlagsForSalon(SLUG);
      expect(flags.length).toBe(2);
      expect(flags.every((f) => f === true)).toBe(true);
    } finally {
      await cleanupTestSalon(SLUG);
    }
  });

  test("toggle OFF persists seat_together=false + hides success copy", async ({
    page,
  }) => {
    const SLUG = "e2e-group-seat-off";
    await seedGroupTestSalon(SLUG);
    try {
      await gotoGroupFlow(page, SLUG);
      await page.getByTestId("group-size-2").click();
      await page.getByTestId("group-size-next").click();
      await page
        .getByTestId("group-step-service-panel")
        .waitFor({ state: "visible" });
      // Turn the preference off before filling the rest.
      await page.getByTestId("group-seat-together").click();
      await expect(page.getByTestId("group-seat-together")).toHaveAttribute(
        "aria-checked",
        "false",
      );
      await fillMemberCard(page, 0, "Mai", 1, 1);
      await fillMemberCard(page, 1, "Linh", 1, 2);
      await page.getByTestId("group-service-next").click();

      await page
        .getByTestId("group-step-date-panel")
        .waitFor({ state: "visible" });
      await pickDateInCalendar(page, nextOpenDateYmd());
      await page.getByTestId("group-arrival-afternoon").click();
      await page.getByTestId("group-date-next").click();

      await page
        .getByTestId("group-step-arrangement-panel")
        .waitFor({ state: "visible" });
      const bestCard = page.getByTestId("group-arrangement-best");
      await expect(bestCard).toBeVisible({ timeout: 20_000 });
      await bestCard.click();
      await page.getByTestId("group-arrangement-next").click();

      await page
        .getByTestId("group-step-confirm-panel")
        .waitFor({ state: "visible" });
      await page.getByTestId("group-primary-phone").fill("+16045550222");
      await page.getByTestId("group-confirm").click();
      await expect(page.getByTestId("booking-group-success")).toBeVisible({
        timeout: 15_000,
      });

      await expect(
        page.getByTestId("group-success-seat-together"),
      ).toHaveCount(0);

      const flags = await seatTogetherFlagsForSalon(SLUG);
      expect(flags.length).toBe(2);
      expect(flags.every((f) => f === false)).toBe(true);
    } finally {
      await cleanupTestSalon(SLUG);
    }
  });
});
