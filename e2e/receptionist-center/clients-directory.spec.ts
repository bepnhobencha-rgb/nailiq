/**
 * E2E — Salon Clients Directory
 *
 * Tests the server-driven search + pagination path on /dashboard/<slug>/clients.
 * Uses the demo-cookie auth bypass (nailiq-demo-slug cookie, same pattern as
 * the receptionist-center specs).
 *
 * ISOLATION: Seeds are namespaced with a unique Te2eImport<rand> prefix so they
 * never collide across parallel CI workers. Cleanup deletes both salon_clients
 * and client_profiles rows for the seeded phone numbers in afterAll.
 */

import { expect, test } from "@playwright/test";

import {
  rcSlug,
  seedReceptionistCenterFixture,
  supabaseAdmin,
  type ReceptionistCenterFixture,
} from "./helpers";
import { cleanupTestSalon } from "../helpers/db";

// ---------------------------------------------------------------------------
// State shared across tests in this file
// ---------------------------------------------------------------------------

let fx: ReceptionistCenterFixture;

/** All phones seeded by this suite — cleaned up in afterAll. */
const seededPhones: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLAYWRIGHT_BASE_URL =
  process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

/** Navigate to /dashboard/<slug>/clients with demo-cookie auth. */
async function gotoClientsPage(
  page: import("@playwright/test").Page,
  slug: string,
): Promise<void> {
  await page.context().addCookies([
    {
      name: "nailiq-demo-slug",
      value: slug,
      url: PLAYWRIGHT_BASE_URL,
    },
  ]);

  // Default language to EN so assertions can use English strings.
  await page.addInitScript(() => {
    try {
      if (window.localStorage.getItem("nailiq-user-lang") == null) {
        window.localStorage.setItem("nailiq-user-lang", "en");
      }
    } catch {
      /* private mode / quota — ignore */
    }
  });

  await page.goto(`/dashboard/${encodeURIComponent(slug)}/clients`);

  // Wait for the panel to settle — either the list or the empty state renders.
  await Promise.race([
    page.getByTestId("client-profiles-list").waitFor({ state: "attached", timeout: 30_000 }),
    page.getByTestId("client-profiles-error").waitFor({ state: "attached", timeout: 30_000 }),
    page.locator('[data-testid^="client-row-"]').first().waitFor({ state: "attached", timeout: 30_000 }),
  ]).catch(() => {
    // Empty state may be present instead; proceed — the test assertion will surface any real issue.
  });
}

/** Generate a unique phone for this test run — 10-digit, never a 555-exchange. */
function uniqueTestPhone(): string {
  const ts = String(Date.now()).slice(-7);
  const rand = String(Math.floor(Math.random() * 1000)).padStart(3, "0");
  return `604${ts}${rand}`.slice(0, 10);
}

/** Generate a unique imported client name for this test run. */
function importedClientName(): string {
  return `Te2eImport${Date.now()}${Math.floor(Math.random() * 1e6)}`;
}

/**
 * Seed a client_profiles row + a salon_clients membership row for the fixture
 * salon, simulating a Square-imported contact with no booking history.
 * Returns the profile id.
 */
async function seedImportedClient(
  salonId: string,
  opts: { name: string; phone: string },
): Promise<{ id: string; storedPhone: string }> {
  // 1. Upsert client_profiles row. Read `phone` BACK — a BEFORE INSERT/UPDATE
  //    trigger canonicalizes it (e.g. 6041234567 → 16041234567), so the stored
  //    value (which drives the `client-row-<phone>` testid) differs from what we
  //    seeded. The card locator + cleanup must use the STORED phone.
  const { data: profile, error: profileErr } = await supabaseAdmin
    .from("client_profiles")
    .upsert(
      {
        phone: opts.phone,
        name: opts.name,
        email: null,
        is_vip: false,
        notes: null,
      },
      { onConflict: "phone" },
    )
    .select("id, phone")
    .single();

  if (profileErr || !profile?.id) {
    throw new Error(
      `seedImportedClient: client_profiles upsert failed — ${profileErr?.message ?? "no id"}`,
    );
  }

  const profileId = profile.id as string;
  const storedPhone = String(
    (profile as { phone?: string | null }).phone ?? opts.phone,
  );

  // 2. Insert salon_clients membership link.
  const { error: linkErr } = await supabaseAdmin
    .from("salon_clients")
    .upsert(
      {
        salon_id: salonId,
        client_profile_id: profileId,
        source: "square_import",
      },
      { onConflict: "salon_id,client_profile_id" },
    );

  if (linkErr) {
    throw new Error(
      `seedImportedClient: salon_clients upsert failed — ${linkErr.message}`,
    );
  }

  // Track for cleanup (by the STORED phone the trigger wrote).
  seededPhones.push(storedPhone);

  return { id: profileId, storedPhone };
}

/** Delete salon_clients + client_profiles rows for seeded phones. */
async function cleanupSeededClients(): Promise<void> {
  if (seededPhones.length === 0) return;
  for (const phone of seededPhones) {
    const { data: profile } = await supabaseAdmin
      .from("client_profiles")
      .select("id")
      .eq("phone", phone)
      .maybeSingle();
    if (profile?.id) {
      // Remove salon_clients link first (FK).
      await supabaseAdmin
        .from("salon_clients")
        .delete()
        .eq("client_profile_id", profile.id);
      // Then delete the profile.
      await supabaseAdmin
        .from("client_profiles")
        .delete()
        .eq("id", profile.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test.beforeAll(async ({}, testInfo) => {
  fx = await seedReceptionistCenterFixture(rcSlug(testInfo.project.name));
});

test.afterAll(async ({}, testInfo) => {
  await cleanupSeededClients();
  await cleanupTestSalon(rcSlug(testInfo.project.name));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Clients directory — imported contact visibility", () => {
  test("imported client appears in directory and is searchable by name", async ({
    page,
  }) => {
    const name = importedClientName();
    const phone = uniqueTestPhone();
    const { storedPhone } = await seedImportedClient(fx.salonId, { name, phone });

    await gotoClientsPage(page, fx.slug);

    // Search by name.
    const searchInput = page.getByTestId("client-profiles-search");
    await searchInput.fill(name);

    // The panel debounces 300ms then fires — wait for the card to appear.
    const card = page.getByTestId(`client-row-${storedPhone}`);
    await expect(card).toBeVisible({ timeout: 10_000 });
  });

  test("imported client appears in directory and is searchable by phone", async ({
    page,
  }) => {
    const name = importedClientName();
    const phone = uniqueTestPhone();
    const { storedPhone } = await seedImportedClient(fx.salonId, { name, phone });

    await gotoClientsPage(page, fx.slug);

    // Search by the last 7 digits (to simulate partial phone entry).
    const searchInput = page.getByTestId("client-profiles-search");
    await searchInput.fill(storedPhone.slice(-7));

    const card = page.getByTestId(`client-row-${storedPhone}`);
    await expect(card).toBeVisible({ timeout: 10_000 });
  });

  test("unrelated name returns empty / no matching card", async ({ page }) => {
    await gotoClientsPage(page, fx.slug);

    const unrelated = `ZZZNeverExists${Date.now()}`;
    const searchInput = page.getByTestId("client-profiles-search");
    await searchInput.fill(unrelated);

    // Wait for debounce + transition to settle.
    await page.waitForTimeout(600);

    // No card matching the unrelated query should be visible.
    const cards = page.locator('[data-testid^="client-row-"]');
    await expect(cards).toHaveCount(0, { timeout: 8_000 });
  });

  test("imported client NOT visible when searching on a DIFFERENT salon", async ({
    page,
  }) => {
    const name = importedClientName();
    const phone = uniqueTestPhone();
    // Seed the imported client ONLY to the fixture salon.
    await seedImportedClient(fx.salonId, { name, phone });

    // Stand up a minimal second salon (no membership for this client) — enough
    // for the clients page to load + the demo-cookie auth to grant a role.
    const otherSlug = `e2e-iso-${Date.now()}${Math.floor(Math.random() * 1e4)}`;
    const { data: otherSalon, error: otherErr } = await supabaseAdmin
      .from("salons")
      .insert({
        slug: otherSlug,
        name: "E2E Isolation Salon",
        phone: "15558889999",
        profile_complete: true,
        timezone: "UTC",
        setup_wizard_completed_at: new Date().toISOString(),
        dashboard_preset: "rush_hour",
      } as never)
      .select("id")
      .single();
    if (otherErr || !otherSalon?.id) {
      throw new Error(`isolation: 2nd salon insert failed — ${otherErr?.message}`);
    }

    try {
      // Load the OTHER salon's clients page and search the Hi-Lite-only name.
      await gotoClientsPage(page, otherSlug);
      const searchInput = page.getByTestId("client-profiles-search");
      await searchInput.fill(name);
      await page.waitForTimeout(700); // debounce + fetch settle

      // The other salon must NOT see the fixture salon's imported client.
      const cards = page.locator('[data-testid^="client-row-"]');
      await expect(cards).toHaveCount(0, { timeout: 8_000 });
    } finally {
      await supabaseAdmin.from("salons").delete().eq("id", otherSalon.id);
    }
  });
});

test.describe("Clients directory — page structure", () => {
  test("search input is accessible (has aria-label)", async ({ page }) => {
    await gotoClientsPage(page, fx.slug);
    const searchInput = page.getByTestId("client-profiles-search");
    await expect(searchInput).toBeVisible({ timeout: 20_000 });
    // aria-label or accessible name must be present.
    const label = await searchInput.getAttribute("aria-label");
    expect(label).toBeTruthy();
  });

  test("page renders without error state", async ({ page }) => {
    await gotoClientsPage(page, fx.slug);
    // Error div must NOT be present.
    await expect(page.getByTestId("client-profiles-error")).toHaveCount(0, {
      timeout: 20_000,
    });
  });
});
