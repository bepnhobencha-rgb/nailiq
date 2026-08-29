/**
 * Phase 6.1 — Web Group Booking Wave Option E2E.
 *
 * A 3-staff salon + a 4-person "Arrive together" group can't all start at once,
 * so the web flow must offer a wave split (wave 1 = 3, wave 2 = 1) instead of
 * dead-ending. Confirming persists wave_number and generates a Party Link.
 *
 * Covers:
 *   - too-large group shows the wave option in the arrangement step
 *   - selecting + confirming the wave option creates the booking + Party Link
 *   - saved bookings carry the correct wave_number
 *   - sync_finish too-large group shows the graceful "Arrive together" message
 *
 * Run: npm run test:e2e -- e2e/party-booking/web-wave-booking.spec.ts
 */
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import {
  cleanupPartyTestSalon,
  seedPartyTestSalon,
  type PartyTestSalon,
} from "./helpers";
import {
  fillMemberCard,
  gotoGroupFlow,
  nextOpenDateYmd,
  pickDateInCalendar,
} from "../group-booking/helpers";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SLUG = "e2e-web-wave";
let salon: PartyTestSalon;

test.beforeAll(async () => {
  salon = await seedPartyTestSalon(SLUG); // 3 staff + 3 services
});

test.afterAll(async () => {
  await cleanupPartyTestSalon(SLUG, salon?.salonId);
});

/** Drive steps 1–4 for a 4-person group; stop on the arrangement panel. */
async function gotoArrangementWith4(
  page: Parameters<typeof gotoGroupFlow>[0],
  opts: { syncFinish?: boolean } = {},
) {
  await gotoGroupFlow(page, SLUG);

  // STEP 1 — group size 4 (selectable now that wave booking raised the cap).
  await page.getByTestId("group-size-4").click();
  await page.getByTestId("group-size-next").click();

  // STEP 2 — 4 members, same service, "Any available" staff (index 0).
  await page.getByTestId("group-step-service-panel").waitFor({ state: "visible" });
  await fillMemberCard(page, 0, "Wave A", 1, 0);
  await fillMemberCard(page, 1, "Wave B", 1, 0);
  await fillMemberCard(page, 2, "Wave C", 1, 0);
  await fillMemberCard(page, 3, "Wave D", 1, 0);
  await page.getByTestId("group-service-next").click();

  // STEP 3 — date + sync mode.
  await page.getByTestId("group-step-date-panel").waitFor({ state: "visible" });
  if (opts.syncFinish) {
    const finishToggle = page.getByTestId("group-sync-finish");
    await finishToggle.waitFor({ state: "visible" });
    await finishToggle.click();
  }
  await pickDateInCalendar(page, nextOpenDateYmd());
  if (opts.syncFinish) {
    // Finish mode shows a target finish-time input instead of arrival windows.
    await page.getByTestId("group-finish-time").fill("16:00");
  } else {
    await page.getByTestId("group-arrival-afternoon").click();
  }
  await page.getByTestId("group-date-next").click();

  await page.getByTestId("group-step-arrangement-panel").waitFor({ state: "visible" });
}

// ─── Arrive together: wave option offered + confirmed ──────────────

test("web group too large shows a wave option, confirms, and saves wave_number", async ({
  page,
}) => {
  await gotoArrangementWith4(page);

  // Wave breakdown is shown (Split into 2 waves: Wave 1 … Wave 2 …).
  await expect(page.getByTestId("group-wave-breakdown")).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId("group-wave-1")).toBeVisible();
  await expect(page.getByTestId("group-wave-2")).toBeVisible();

  // Select the (only) arrangement card and continue.
  await page.getByTestId("group-arrangement-best").click();
  await page.getByTestId("group-arrangement-next").click();

  // STEP 5 — contact + submit. Unique phone so we can find the group.
  const phone = "+16045553344";
  await page.getByTestId("group-step-confirm-panel").waitFor({ state: "visible" });
  await page.getByTestId("group-primary-phone").fill(phone);
  // The phone-first gate normally captures SMS consent. The confirm-step
  // checkbox is a fallback only, so it is intentionally absent in that case.
  const groupSmsConsent = page.getByTestId("group-sms-consent");
  if (await groupSmsConsent.isVisible()) {
    await groupSmsConsent.check();
  }
  await page.getByTestId("group-confirm").click();

  await expect(page.getByTestId("booking-group-success")).toBeVisible({ timeout: 20_000 });

  // Party Link appears.
  await expect(page.getByTestId("party-link-share")).toBeVisible({ timeout: 15_000 });
  const url = await page.getByTestId("party-link-url").inputValue();
  const token = url.match(/\/party\/([0-9a-f]{16})/)?.[1];
  expect(token, "party link token").toBeTruthy();

  // Resolve group_id from the party link, then assert wave_number split (3 + 1).
  const { data: link } = await supabase
    .from("party_links")
    .select("group_id")
    .eq("token", token!)
    .single();
  expect(link?.group_id).toBeTruthy();

  const { data: rows } = await supabase
    .from("bookings")
    .select("wave_number")
    .eq("group_id", link!.group_id);
  expect(rows?.length).toBe(4);
  const w1 = (rows ?? []).filter((r) => r.wave_number === 1).length;
  const w2 = (rows ?? []).filter((r) => r.wave_number === 2).length;
  expect(w1).toBe(3);
  expect(w2).toBe(1);
});

// ─── Finish together: too-large group shows graceful message ───────

test("web sync_finish too-large group shows the Arrive-together message", async ({ page }) => {
  await gotoArrangementWith4(page, { syncFinish: true });

  // No finish-together arrangement for 4 people on 3 staff → graceful banner.
  await expect(page.getByTestId("group-wave-finish-unsupported")).toBeVisible({ timeout: 25_000 });
  await expect(page.getByTestId("group-wave-finish-unsupported")).toContainText(/arrive together/i);
});
