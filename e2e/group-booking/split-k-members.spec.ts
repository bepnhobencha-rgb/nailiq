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
 * A 4-person group asking for the morning therefore cannot fit (the 2nd wave
 * has no morning chair) → no_slots. The split option must seat the largest
 * prefix that fits (2 at 09:00) and place BOTH remaining members later
 * (≈12:00), i.e. lateCount === 2 — the behaviour the old single-late split
 * could never produce.
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

  test("4-person morning group → split seats 2 now + 2 later (lateCount === 2)", async ({
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

    // Step 4 — the scheduler returns no_slots for the morning and surfaces
    // the alternatives, including the split.
    await page
      .getByTestId("group-step-arrangement-panel")
      .waitFor({ state: "visible" });

    const splitCard = page.getByTestId("group-alt-split");
    await expect(splitCard).toBeVisible({ timeout: 20_000 });

    // The headline must report 2 members spilling to a later slot —
    // "{2} together at …, {2} more by …" — which the old 1-member split
    // could never show.
    await expect(splitCard).toContainText(/2 more/i);
    await expect(splitCard).toContainText(/2 together/i);
  });
});
