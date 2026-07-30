/**
 * E2E tests for the AI Prefill Setup Wizard (/setup/ai-prefill).
 *
 * The Anthropic Vision API is mocked via AI_PREFILL_E2E_MOCK=services
 * (set in playwright.config.ts webServer.command). The server action
 * short-circuits and returns a fixture of 3 nail services instead of
 * making a real network call.
 *
 * Auth: demo cookie (nailiq-demo-slug={slug}) with NAILIQ_TEST_BYPASS_SLUG_PIN=1.
 */

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { cleanupTestSalon, seedEmptyTestSalon } from "./helpers/db";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, serviceKey);

const TEST_SLUG = "e2e-ai-prefill-salon";

/** Navigate to the wizard with demo cookie set. */
async function gotoWizard(page: Page) {
  await page.context().addCookies([
    {
      name: "nailiq-demo-slug",
      value: TEST_SLUG,
      domain: "localhost",
      path: "/",
    },
  ]);
  await page.goto(`/dashboard/${TEST_SLUG}/setup/ai-prefill`);
  await expect(page.getByTestId("ai-prefill-url-input")).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("AI Prefill Setup Wizard", () => {
  test.beforeAll(async () => {
    await seedEmptyTestSalon({
      phone: "15550002222",
      slug: TEST_SLUG,
      name: "E2E AI Prefill Salon",
    });
  });

  test.afterAll(async () => {
    await cleanupTestSalon(TEST_SLUG);
  });

  // Clean up services between tests so they don't pollute each other
  test.afterEach(async () => {
    const { data: salon } = await supabase
      .from("salons")
      .select("id")
      .eq("slug", TEST_SLUG)
      .maybeSingle();
    if (salon?.id) {
      await supabase.from("services").delete().eq("salon_id", salon.id as string);
    }
  });

  // ── Step 1: wizard renders correctly ───────────────────────────────────

  test("wizard page renders all 3 input method cards", async ({ page }) => {
    await gotoWizard(page);

    await expect(page.getByTestId("ai-prefill-upload-btn")).toBeVisible();
    await expect(page.getByTestId("ai-prefill-url-input")).toBeVisible();
    await expect(page.getByTestId("ai-prefill-manual-btn")).toBeVisible();
  });

  // ── Happy path: URL input → mock AI → review → import ─────────────────

  test("happy path: URL analyze → review 3 services → import to DB", async ({ page }) => {
    await gotoWizard(page);

    // Enter a URL and trigger analysis
    await page.getByTestId("ai-prefill-url-input").fill("https://example.com/menu.jpg");
    await page.getByTestId("ai-prefill-url-analyze").click();

    // Loading step appears
    await expect(page.getByTestId("ai-prefill-loading")).toBeVisible({ timeout: 5_000 });

    // Review step appears (mock returns 3 services instantly)
    await expect(page.getByTestId("ai-prefill-review")).toBeVisible({ timeout: 15_000 });

    // Verify 3 fixture services are shown
    const rows = page.getByTestId("ai-prefill-service-row");
    await expect(rows).toHaveCount(3);

    // Verify fixture service names appear
    await expect(page.getByText("Gel Manicure")).toBeVisible();
    await expect(page.getByText("Regular Manicure")).toBeVisible();
    await expect(page.getByText("Acrylic Full Set")).toBeVisible();

    // Import button shows correct count
    const importBtn = page.getByTestId("ai-prefill-import-btn");
    await expect(importBtn).toContainText("3");
    await importBtn.click();

    // Redirect to /setup/services after import
    await expect(page).toHaveURL(/setup\/services/, { timeout: 10_000 });

    // Verify services landed in DB
    const { data: salon } = await supabase
      .from("salons")
      .select("id")
      .eq("slug", TEST_SLUG)
      .maybeSingle();
    expect(salon?.id).toBeTruthy();

    const { count } = await supabase
      .from("services")
      .select("id", { count: "exact", head: true })
      .eq("salon_id", salon!.id as string)
      .is("deleted_at" as never, null);

    expect(count).toBe(3);
  });

  // ── Partial selection: deselect 1 row → import only 2 ─────────────────

  test("partial selection: deselect one row → imports only 2 services", async ({ page }) => {
    await gotoWizard(page);

    await page.getByTestId("ai-prefill-url-input").fill("https://example.com/menu.jpg");
    await page.getByTestId("ai-prefill-url-analyze").click();
    await expect(page.getByTestId("ai-prefill-review")).toBeVisible({ timeout: 15_000 });

    // Uncheck the first row
    const firstCheckbox = page
      .getByTestId("ai-prefill-service-row")
      .first()
      .locator("input[type='checkbox']");
    await firstCheckbox.uncheck();

    // Import button now shows 2
    const importBtn = page.getByTestId("ai-prefill-import-btn");
    await expect(importBtn).toContainText("2");
    await importBtn.click();

    await expect(page).toHaveURL(/setup\/services/, { timeout: 10_000 });

    const { data: salon } = await supabase
      .from("salons")
      .select("id")
      .eq("slug", TEST_SLUG)
      .maybeSingle();

    const { count } = await supabase
      .from("services")
      .select("id", { count: "exact", head: true })
      .eq("salon_id", salon!.id as string)
      .is("deleted_at" as never, null);

    expect(count).toBe(2);
  });

  // ── Fallback: manual card skips AI entirely ────────────────────────────

  test("fallback: clicking manual card redirects to /setup/services", async ({ page }) => {
    await gotoWizard(page);

    // Click "Enter manually" card — no AI call made
    await page.getByTestId("ai-prefill-manual-btn").click();

    await expect(page).toHaveURL(/setup\/services/, { timeout: 8_000 });
  });

  // ── Fallback from review: "Enter manually" escape hatch ───────────────

  test("fallback from review: manual fallback button redirects to /setup/services", async ({ page }) => {
    await gotoWizard(page);

    await page.getByTestId("ai-prefill-url-input").fill("https://example.com/menu.jpg");
    await page.getByTestId("ai-prefill-url-analyze").click();
    await expect(page.getByTestId("ai-prefill-review")).toBeVisible({ timeout: 15_000 });

    // Click the "Enter manually instead" ghost button at bottom
    await page.getByTestId("ai-prefill-manual-fallback").click();

    await expect(page).toHaveURL(/setup\/services/, { timeout: 8_000 });
  });

  // ── Validation: empty URL doesn't trigger analysis ────────────────────

  test("analyze button is disabled when URL input is empty", async ({ page }) => {
    await gotoWizard(page);

    const analyzeBtn = page.getByTestId("ai-prefill-url-analyze");
    await expect(analyzeBtn).toBeDisabled();

    await page.getByTestId("ai-prefill-url-input").fill("https://example.com/menu.jpg");
    await expect(analyzeBtn).toBeEnabled();
  });

  // ── Banner: empty service list shows AI import banner ─────────────────

  test("services page shows import banner when service list is empty", async ({ page }) => {
    await page.context().addCookies([
      {
        name: "nailiq-demo-slug",
        value: TEST_SLUG,
        domain: "localhost",
        path: "/",
      },
    ]);
    await page.goto(`/dashboard/${TEST_SLUG}/setup/services`);

    // Banner should be visible (0 services salon)
    await expect(page.getByRole("link", { name: /import from photo/i })).toBeVisible({
      timeout: 10_000,
    });
  });
});
