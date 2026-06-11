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
 * Party Link no-redundancy: the organizer (primary contact) already
 * booked, so when they're also a guest ("I'm also getting a service"
 * default on) their OWN slot is pre-claimed — the share link must not
 * ask them to claim themselves. Exactly one claim (theirs) is claimed;
 * the other guest's slot stays open.
 */

const SLUG = "e2e-group-preclaim";
const ORG_PHONE = "16045550999";
const ORG_NAME = "Mai Organizer";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

test.describe("Group booking — organizer slot pre-claimed", () => {
  test.beforeAll(async () => {
    await seedGroupTestSalon(SLUG);
    await supabase
      .from("client_profiles")
      .upsert(
        { phone: ORG_PHONE, name: ORG_NAME, is_vip: false, visit_count: 2 },
        { onConflict: "phone" },
      );
  });
  test.afterAll(async () => {
    await supabase.from("client_profiles").delete().eq("phone", ORG_PHONE);
    await cleanupTestSalon(SLUG);
  });

  test("organizer's own slot is pre-claimed; the other guest's is open", async ({
    page,
  }) => {
    await gotoGroupFlow(page, SLUG);
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
    const best = page.getByTestId("group-arrangement-best");
    await expect(best).toBeVisible({ timeout: 20_000 });
    await best.click();
    await page.getByTestId("group-arrangement-next").click();

    await page
      .getByTestId("group-step-confirm-panel")
      .waitFor({ state: "visible" });
    // "I'm also getting a service" is on by default.
    await expect(page.getByTestId("group-organizer-is-guest")).toBeVisible();
    await page.getByTestId("group-primary-phone").fill(`+${ORG_PHONE}`);
    await page.getByTestId("group-sms-consent").check();
    await page.getByTestId("group-confirm").click();
    await expect(page.getByTestId("booking-group-success")).toBeVisible({
      timeout: 15_000,
    });

    // Find this salon's group + its claims (createPartyLink runs after
    // success, non-blocking) — poll until the claims land.
    const { data: salon } = await supabase
      .from("salons")
      .select("id")
      .eq("slug", SLUG)
      .maybeSingle();
    const salonId = salon!.id as string;

    let claims: { claimed_at: string | null; member_name: string | null }[] = [];
    for (let i = 0; i < 20; i++) {
      const { data: links } = await supabase
        .from("party_links")
        .select("id")
        .eq("salon_id", salonId);
      const linkId = links?.[0]?.id;
      if (linkId) {
        const { data } = await supabase
          .from("party_link_claims")
          .select("claimed_at, member_name")
          .eq("party_link_id", linkId);
        if (data && data.length === 2) {
          claims = data;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    expect(claims.length).toBe(2);
    const claimed = claims.filter((c) => c.claimed_at !== null);
    // Exactly the organizer's slot is pre-claimed (Guest 1 = "Mai"); the
    // other guest's slot stays open for them to claim.
    expect(claimed.length).toBe(1);
    expect(claimed[0].member_name).toBe("Mai");
  });
});
