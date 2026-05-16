import { test, expect } from "@playwright/test";

/**
 * Phase 1F audit-log viewer — E2E coverage.
 *
 * Today this file only covers the unauthenticated-redirect case
 * because there is no superadmin-auth helper in `e2e/helpers/` yet
 * (the broader superadmin surface lands across PRs without e2e
 * coverage; building the auth-helper is a follow-up).
 *
 * Pending coverage (tracked in PR body as out-of-scope follow-up):
 *   - Role gating: founder allowed, support_admin allowed,
 *     billing_admin / ai_admin denied (loader returns `forbidden`)
 *   - Empty state with no rows seeded
 *   - Pagination across 75 rows (page size 50)
 *   - Filter combination (action + date range)
 *   - Inline diff expander renders before/after
 *   - Unknown `action` verb renders without crashing
 *   - NULL actor_user_id renders "(deleted user)"
 */

test.describe("SuperAdmin audit logs — unauthenticated", () => {
  test("anonymous visit redirects to /superadmin/login", async ({
    page,
  }) => {
    await page.goto("/superadmin/support/audit-logs");
    await expect(page).toHaveURL(/\/superadmin\/login/);
  });

  test("Support nav redirect lands on login when signed out", async ({
    page,
  }) => {
    await page.goto("/superadmin/support");
    await expect(page).toHaveURL(/\/superadmin\/login/);
  });
});
