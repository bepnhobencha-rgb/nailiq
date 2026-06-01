/**
 * SuperAdmin platform feature-flag toggle — E2E coverage.
 *
 * Closes two of the follow-ups flagged in `audit-logs.spec.ts`:
 *   1. Drive an authenticated superadmin surface (new helper in
 *      `e2e/helpers/superadmin.ts`).
 *   2. Verify that a mutating SuperAdmin action writes its audit row.
 *
 * Flow under test (`/superadmin/operations/feature-flags`):
 *   - Toggle the `sms_enabled` platform flag ON, then OFF.
 *   - Each toggle persists to `platform_flags` (asserted via service role).
 *   - Each toggle writes a `platform_flag_set` audit row whose
 *     `after_jsonb.enabled` matches the new state (PERMISSION_MATRIX §8.5).
 *   - The audit-log viewer surfaces the resulting entries with a diff.
 *
 * `sms_enabled` is chosen because it is a non-`danger` flag — toggling it
 * does NOT trigger the window.confirm() friction that the danger flags
 * (`demo_otp_enabled`) gate behind, keeping the toggle path deterministic.
 *
 * ⚠️ SAFETY: this test MUTATES a platform-wide flag (affects EVERY salon).
 * It is SKIPPED BY DEFAULT when the target DB is the production Supabase
 * project (detected via VERCEL_ENV=production or the prod project ref in
 * NEXT_PUBLIC_SUPABASE_URL). Run it against a staging/test DB normally, or
 * deliberately opt in against production with ALLOW_PROD_PLATFORM_FLAG_E2E=true.
 * Capture-and-restore guarantees the original value is put back regardless.
 */
import { test, expect } from "@playwright/test";
import {
  cleanupTestSuperadmin,
  getLatestAuditLog,
  getPlatformFlag,
  loginAsSuperadmin,
  seedTestSuperadmin,
  setPlatformFlag,
  type SeededSuperAdmin,
} from "../helpers/superadmin";

const FLAG_KEY = "sms_enabled";

// Production guard — refuse to mutate a global flag on the live DB unless
// explicitly allowed. The prod project ref is matched on the Supabase URL so
// the guard holds even if VERCEL_ENV isn't propagated to the test runner.
const PROD_PROJECT_REF = "fshmobzyjhmtvndobwsy";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const IS_PROD_DB =
  process.env.VERCEL_ENV === "production" ||
  SUPABASE_URL.includes(PROD_PROJECT_REF);
const ALLOW_PROD = process.env.ALLOW_PROD_PLATFORM_FLAG_E2E === "true";
const SKIP_MUTATING = IS_PROD_DB && !ALLOW_PROD;

// Use describe.skip when guarded so even beforeAll (which seeds + flips the
// flag) never runs against production. Set ALLOW_PROD_PLATFORM_FLAG_E2E=true
// to override deliberately.
const describeFlagToggle = SKIP_MUTATING ? test.describe.skip : test.describe;

let admin: SeededSuperAdmin;
let originalSmsEnabled = false;

test.describe.configure({ mode: "serial" });

describeFlagToggle("SuperAdmin · platform feature-flag toggle + audit trail", () => {
  test.beforeAll(async () => {
    admin = await seedTestSuperadmin({ role: "founder" });
    // `sms_enabled` is platform-wide (affects EVERY salon), and this suite
    // runs against the working Supabase project. Capture the live value
    // BEFORE forcing the test baseline so afterAll can restore it exactly —
    // never assume the flag was OFF.
    originalSmsEnabled = (await getPlatformFlag(FLAG_KEY))?.enabled ?? false;
    // Deterministic baseline: start OFF so the first toggle flips ON.
    await setPlatformFlag(FLAG_KEY, false);
  });

  test.afterAll(async () => {
    // Restore the captured original, not a hardcoded value.
    await setPlatformFlag(FLAG_KEY, originalSmsEnabled);
    if (admin) await cleanupTestSuperadmin(admin.userId);
  });

  test("toggle ON then OFF — each persists and writes a matching audit row", async ({
    page,
  }) => {
    await loginAsSuperadmin(page, admin);

    await page.goto("/superadmin/operations/feature-flags");
    const toggle = page.getByTestId(`platform-flag-toggle-${FLAG_KEY}`);
    await expect(toggle).toBeVisible();
    // Baseline is OFF (set in beforeAll, read at server render time).
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    // ── Toggle ON ──────────────────────────────────────────────────
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(
      page.getByTestId(`platform-flag-${FLAG_KEY}`).getByText("Saved ✓"),
    ).toBeVisible();

    // Persisted to platform_flags.
    await expect
      .poll(async () => (await getPlatformFlag(FLAG_KEY))?.enabled, {
        timeout: 10_000,
      })
      .toBe(true);

    // Audit row written by THIS actor, after-state = enabled true.
    await expect
      .poll(
        async () => {
          const row = await getLatestAuditLog({
            actorUserId: admin.userId,
            action: "platform_flag_set",
          });
          return row?.after_jsonb?.enabled;
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    const onRow = await getLatestAuditLog({
      actorUserId: admin.userId,
      action: "platform_flag_set",
    });
    expect(onRow?.actor_role).toBe("founder");
    expect(onRow?.target_kind).toBe("platform_flag");
    expect(onRow?.after_jsonb?.key).toBe(FLAG_KEY);
    expect(onRow?.before_jsonb?.enabled).toBe(false);

    // ── Toggle OFF ─────────────────────────────────────────────────
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await expect
      .poll(async () => (await getPlatformFlag(FLAG_KEY))?.enabled, {
        timeout: 10_000,
      })
      .toBe(false);

    await expect
      .poll(
        async () => {
          const row = await getLatestAuditLog({
            actorUserId: admin.userId,
            action: "platform_flag_set",
          });
          return row?.after_jsonb?.enabled;
        },
        { timeout: 10_000 },
      )
      .toBe(false);

    const offRow = await getLatestAuditLog({
      actorUserId: admin.userId,
      action: "platform_flag_set",
    });
    expect(offRow?.before_jsonb?.enabled).toBe(true);
    expect(offRow?.after_jsonb?.enabled).toBe(false);
  });

  test("audit-log viewer surfaces the platform_flag_set entries", async ({
    page,
  }) => {
    await loginAsSuperadmin(page, admin);

    await page.goto("/superadmin/support/audit-logs");
    await expect(page.getByTestId("superadmin-audit-table")).toBeVisible();

    // Two toggles (ON + OFF) above produced two platform_flag_set rows.
    const flagRows = page.locator(
      '[data-testid="superadmin-audit-row"][data-action="platform_flag_set"]',
    );
    await expect(flagRows.first()).toBeVisible();
    expect(await flagRows.count()).toBeGreaterThanOrEqual(2);

    // The newest row carries our actor email and an expandable diff.
    const firstRow = flagRows.first();
    await expect(firstRow).toContainText(admin.email);

    const diff = firstRow.getByTestId("superadmin-audit-diff");
    await diff.locator("summary").click();
    await expect(diff).toContainText("enabled");
  });
});
