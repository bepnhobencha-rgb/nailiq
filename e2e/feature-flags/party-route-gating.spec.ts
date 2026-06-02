/**
 * PR3 — public party-link route gating E2E (sibling of route-gating.spec.ts).
 *
 * The public `/party/[token]` page 404s when the salon's `group_booking` Beta
 * release feature is OFF (jsonb `feature_flags.group_booking_enabled`, default
 * OFF). A shared/old link must stop resolving once a salon turns Group Booking
 * off — so we seed a real `party_links` row + token and assert:
 *   - OFF salon → the not-found boundary is served, slot cards are NOT.
 *   - ON salon  → the party link page renders its slot cards.
 *
 * Seeding lives in `../party-booking/helpers` (`seedPartyTestSalon` +
 * `seedPartyLink`), which is why this is a sibling spec rather than another
 * block inside route-gating.spec.ts (that file only depends on `helpers/db`).
 *
 * Assertions are CONTENT-based, not HTTP-status based — same force-dynamic
 * streaming caveat documented in route-gating.spec.ts (notFound() still streams
 * HTTP 200 here). The party page needs no auth: the token is the capability.
 */
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import {
  cleanupPartyTestSalon,
  seedPartyLink,
  seedPartyTestSalon,
  type PartyTestSalon,
  type SeededPartyLink,
} from "../party-booking/helpers";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const SLUG_OFF = "e2e-flag-group-off";
const SLUG_ON = "e2e-flag-group-on";

let salonOff: PartyTestSalon;
let salonOn: PartyTestSalon;
let linkOff: SeededPartyLink;
let linkOn: SeededPartyLink;

test.describe("Release feature route gating — group_booking (party link)", () => {
  test.beforeAll(async () => {
    // `seedPartyTestSalon` → `seedGroupTestSalon` enables group_booking_enabled
    // by default. For the OFF case we flip the flag back off after seeding so
    // the column/jsonb resolves to the Beta default (OFF) at request time.
    salonOff = await seedPartyTestSalon(SLUG_OFF);
    await supabase
      .from("salons")
      .update({ feature_flags: { group_booking_enabled: false } })
      .eq("id", salonOff.salonId);
    linkOff = await seedPartyLink({
      salonId: salonOff.salonId,
      staffIds: salonOff.staffIds,
      serviceIds: salonOff.serviceIds,
      slotCount: 2,
      hoursFromNow: 5,
    });

    // ON salon keeps the seed default (group_booking_enabled: true).
    salonOn = await seedPartyTestSalon(SLUG_ON);
    linkOn = await seedPartyLink({
      salonId: salonOn.salonId,
      staffIds: salonOn.staffIds,
      serviceIds: salonOn.serviceIds,
      slotCount: 2,
      hoursFromNow: 5,
    });
  });

  test.afterAll(async () => {
    await cleanupPartyTestSalon(SLUG_OFF, salonOff?.salonId);
    await cleanupPartyTestSalon(SLUG_ON, salonOn?.salonId);
  });

  test("group_booking OFF → /party/[token] serves the not-found page, not slots", async ({
    page,
  }) => {
    // A valid token whose salon has Group Booking disabled must 404 — do NOT
    // use gotoPartyLinkPage here (it waits for slot cards that never render).
    await page.goto(`/party/${linkOff.token}`);
    // global not-found.tsx boundary is the visible DOM
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
    // party slot cards must not be served
    await expect(
      page.locator('[data-testid^="party-slot-card-"]'),
    ).toHaveCount(0);
  });

  test("group_booking ON → /party/[token] serves the party link page", async ({
    page,
  }) => {
    await page.goto(`/party/${linkOn.token}`);
    // flag ON → the public party link renders its seeded slot cards
    await expect(
      page.locator('[data-testid^="party-slot-card-"]'),
    ).toHaveCount(2, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeHidden();
  });
});
