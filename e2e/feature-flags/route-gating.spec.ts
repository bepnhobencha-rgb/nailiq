/**
 * PR3 — route gating E2E.
 *
 * A Beta release feature OFF must refuse direct page access; the same route
 * serves its real content once the salon's flag is enabled. `loyalty` is used
 * because it has a per-salon override path (`feature_flags.loyalty_enabled`),
 * so the same route can be seeded OFF and ON.
 *
 * Assertions are CONTENT-based, not HTTP-status based. This app renders the
 * global `not-found.tsx` boundary in response to `notFound()` but the document
 * still streams with HTTP 200 (a force-dynamic streaming artifact shared by
 * every notFound() route here, e.g. /v/[token]). The security property is
 * "protected content is not served" — so we assert the not-found UI is visible
 * and the loyalty content is not, rather than asserting a 404 status code.
 *
 * Auth: the `nailiq-demo-slug` cookie grants demo dashboard access to the
 * seeded slug (NAILIQ_TEST_BYPASS_SLUG_PIN=1 in CI/local test env).
 */
import { test, expect, type Page } from "@playwright/test";
import { cleanupTestSalon, seedTestSalon } from "../helpers/db";

const SLUG_OFF = "e2e-flag-loyalty-off";
const SLUG_ON = "e2e-flag-loyalty-on";
const VOICE_SLUG_OFF = "e2e-flag-voice-off";
const VOICE_SLUG_ON = "e2e-flag-voice-on";
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

async function authAs(page: Page, slug: string) {
  await page.context().addCookies([
    { name: "nailiq-demo-slug", value: slug, url: BASE },
  ]);
}

test.describe("Release feature route gating — loyalty", () => {
  test.beforeAll(async () => {
    await seedTestSalon({ slug: SLUG_OFF, name: "Loyalty OFF", phone: "15553331001" });
    await seedTestSalon({
      slug: SLUG_ON,
      name: "Loyalty ON",
      phone: "15553331002",
      feature_flags: { loyalty_enabled: true },
    });
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SLUG_OFF);
    await cleanupTestSalon(SLUG_ON);
  });

  test("flag OFF → /setup/loyalty serves the not-found page, not loyalty", async ({
    page,
  }) => {
    await authAs(page, SLUG_OFF);
    await page.goto(`/dashboard/${SLUG_OFF}/setup/loyalty`);
    // not-found.tsx boundary is the visible DOM
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
    // loyalty content must not be served
    await expect(
      page.getByRole("heading", { name: "Studio Feature" }),
    ).toBeHidden();
  });

  test("flag ON → /setup/loyalty serves the loyalty page", async ({ page }) => {
    await authAs(page, SLUG_ON);
    await page.goto(`/dashboard/${SLUG_ON}/setup/loyalty`);
    // free-plan salon with the flag ON renders the loyalty upsell content
    await expect(
      page.getByRole("heading", { name: "Studio Feature" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeHidden();
  });

  test("Base route /center still loads regardless of beta flags", async ({
    page,
  }) => {
    await authAs(page, SLUG_OFF);
    await page.goto(`/dashboard/${SLUG_OFF}/center`);
    // Base routes are never gated — the not-found boundary must not appear.
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeHidden();
  });
});

test.describe("Release feature route gating — ai_voice", () => {
  // `ai_voice` is the one Beta surface sourced from a dedicated COLUMN
  // (`salons.voice_ai_enabled`), not a `feature_flags` jsonb key — so the OFF
  // salon leaves the column unset (Beta default OFF) and the ON salon sets it
  // true via `seedTestSalon({ voice_ai_enabled: true })`. The demo-cookie auth
  // path resolves as role `owner`, so the owner-only Voice setup page renders
  // when the flag is on. Same content-based (not HTTP-status) assertion as the
  // loyalty block — see the file header for why.
  test.beforeAll(async () => {
    await seedTestSalon({
      slug: VOICE_SLUG_OFF,
      name: "Voice OFF",
      phone: "15553331003",
    });
    await seedTestSalon({
      slug: VOICE_SLUG_ON,
      name: "Voice ON",
      phone: "15553331004",
      voice_ai_enabled: true,
    });
  });

  test.afterAll(async () => {
    await cleanupTestSalon(VOICE_SLUG_OFF);
    await cleanupTestSalon(VOICE_SLUG_ON);
  });

  test("flag OFF → /setup/voice serves the not-found page, not voice settings", async ({
    page,
  }) => {
    await authAs(page, VOICE_SLUG_OFF);
    await page.goto(`/dashboard/${VOICE_SLUG_OFF}/setup/voice`);
    // not-found.tsx boundary is the visible DOM
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
    // voice settings content must not be served
    await expect(
      page.getByRole("heading", { name: "Voice AI Settings" }),
    ).toBeHidden();
  });

  test("flag ON → /setup/voice serves the voice settings page", async ({
    page,
  }) => {
    await authAs(page, VOICE_SLUG_ON);
    await page.goto(`/dashboard/${VOICE_SLUG_ON}/setup/voice`);
    // voice_ai_enabled column true → the Voice AI setup form renders
    await expect(
      page.getByRole("heading", { name: "Voice AI Settings" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Page not found" }),
    ).toBeHidden();
  });
});
