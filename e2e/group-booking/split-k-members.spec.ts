import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { cleanupTestSalon } from "../helpers/db";
import {
  fillMemberCard,
  gotoGroupFlow,
  nextOpenDateYmd,
  pickDateInCalendar,
  seedGroupTestSalon,
} from "./helpers";

/**
 * Pha 1.2 regression — the generalized split must spill MORE THAN ONE member.
 *
 * Setup (salon tz America/Los_Angeles, open 09:00–18:00, 3 staff):
 *   - every service forced to 45 min so the morning wave is 09:00–09:45;
 *   - staff[2] blocked all day → only 2 chairs at 09:00;
 *   - staff[0] + staff[1] blocked 09:50–12:00 → the morning can host exactly
 *     ONE wave; the afternoon is wide open.
 *
 * A 4-person group asking for the morning can use rolling capacity: seat the
 * largest prefix that fits (2 at 09:00), skip the blocked 09:50 release, and
 * place BOTH remaining members when capacity returns at 12:00. The scheduler
 * must return that complete plan directly instead of presenting no_slots.
 */
const SLUG = "e2e-group-split-k";
const PT = "-07:00"; // PDT — the test day is in June, always PDT.

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function ptIso(ymd: string, hm: string): string {
  return new Date(`${ymd}T${hm}:00${PT}`).toISOString();
}

const targetYmd = nextOpenDateYmd();

test.describe("Group booking — generalized split (K late members)", () => {
  test.beforeAll(async () => {
    const { salonId, staffIds, serviceIds } = await seedGroupTestSalon(SLUG);

    // Uniform 45-min services so the morning wave is a known 09:00–09:45.
    await supabase
      .from("services")
      .update({ duration_minutes: 45, buffer_minutes: 5 })
      .eq("salon_id", salonId);

    const svc = serviceIds[0];
    const block = async (staffId: string, from: string, to: string, who: string) => {
      const { error } = await supabase.from("bookings").insert({
        salon_id: salonId,
        service_id: svc,
        client_name: who,
        staff_id: staffId,
        start_time_utc: ptIso(targetYmd, from),
        end_time_utc: ptIso(targetYmd, to),
        status: "confirmed",
        source: "appointment",
        price_cents: 3000,
      });
      if (error) throw new Error(`block ${who}: ${error.message}`);
    };

    // staff[2] busy all day; staff[0]+[1] busy after the first morning wave.
    await block(staffIds[2], "09:00", "18:00", "E2E_BLOCK_ALLDAY");
    await block(staffIds[0], "09:50", "12:00", "E2E_BLOCK_S0");
    await block(staffIds[1], "09:50", "12:00", "E2E_BLOCK_S1");
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
  });

  test("4-person morning group → rolling plan seats 2 now + 2 at the next usable release", async ({
    page,
  }) => {
    await gotoGroupFlow(page, SLUG);

    await page.getByTestId("group-size-4").click();
    await page.getByTestId("group-size-next").click();

    // All four pick the same 45-min service, "Any available" staff.
    await fillMemberCard(page, 0, "Mai", 1, 0);
    await fillMemberCard(page, 1, "Linh", 1, 0);
    await fillMemberCard(page, 2, "Hoa", 1, 0);
    await fillMemberCard(page, 3, "Lan", 1, 0);
    await page.getByTestId("group-service-next").click();

    await pickDateInCalendar(page, targetYmd);
    await page.getByTestId("group-arrival-morning").click();
    await page.getByTestId("group-date-next").click();

    // Step 4 — the scheduler returns one complete rolling plan directly.
    await page
      .getByTestId("group-step-arrangement-panel")
      .waitFor({ state: "visible" });

    await expect(page.getByTestId("group-alt-split")).toHaveCount(0, {
      timeout: 20_000,
    });
    const rollingCard = page.getByTestId("group-arrangement-best");
    await expect(rollingCard).toBeVisible({ timeout: 20_000 });
    const firstWave = rollingCard.getByTestId("group-wave-1");
    const secondWave = rollingCard.getByTestId("group-wave-2");
    await expect(firstWave).toContainText(/2 guests/i);
    await expect(firstWave).toContainText(/9:00/i);
    await expect(secondWave).toContainText(/2 guests/i);
    await expect(secondWave).toContainText(/12:00/i);
    await expect(page.getByTestId("group-arrangement-next")).toBeEnabled();
  });
});
