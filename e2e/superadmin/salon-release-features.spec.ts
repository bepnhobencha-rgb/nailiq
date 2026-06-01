import { test, expect } from "@playwright/test";
import { cleanupTestSalon, seedTestSalon } from "../helpers/db";
import {
  cleanupTestSuperadmin,
  getLatestAuditLog,
  loginAsSuperadmin,
  seedTestSuperadmin,
  type SeededSuperAdmin,
} from "../helpers/superadmin";

/**
 * SuperAdmin "Release features" panel (`SalonReleaseFeaturesCard`) on
 * `/superadmin/salons/[salonId]`.
 *
 * Two describes:
 *   1. Display (PR4a) — seeds a salon with two overrides diverging from the
 *      registry defaults, asserts the panel/copy/groups/override badges.
 *   2. Editable controls (PR4b-1) — toggles a jsonb-sourced feature ON, asserts
 *      resolved state + audit row, resets it to default, and confirms
 *      plan/column sources stay read-only (no toggle).
 */

/** Navigate to a salon detail page after settling the post-login redirect.
 * loginAsSuperadmin resolves on the intermediate `/superadmin` URL which then
 * client-redirects to `/superadmin/dashboard`; on the slower mobile project the
 * redirect is still in flight when the next goto fires and Playwright aborts it
 * ("interrupted by another navigation"). Wait for it to settle first. */
async function gotoSalonDetail(
  page: import("@playwright/test").Page,
  salonId: string,
) {
  await page
    .waitForURL(/\/superadmin\/dashboard(\/|$)/, { timeout: 30_000 })
    .catch(() => {});
  await page.goto(`/superadmin/salons/${salonId}`);
}

const SALON_SLUG = "e2e-release-features-panel";

let admin: SeededSuperAdmin;
let salonId: string;

test.describe.configure({ mode: "serial" });

test.describe("SuperAdmin · read-only salon release-features panel", () => {
  test.beforeAll(async () => {
    admin = await seedTestSuperadmin({ role: "founder" });
    const seeded = await seedTestSalon({
      slug: SALON_SLUG,
      name: "E2E Release Features Salon",
      phone: "15550007777",
      feature_flags: {
        // Beta default OFF → forced ON (override)
        group_booking_enabled: true,
        // Base default ON → forced OFF (override)
        receptionist_center_enabled: false,
      },
    });
    salonId = seeded.salonId;
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SALON_SLUG);
    if (admin) await cleanupTestSuperadmin(admin.userId);
  });

  test("panel renders resolved state, groups, copy, and override badges", async ({
    page,
  }) => {
    await loginAsSuperadmin(page, admin);
    // loginAsSuperadmin resolves on the intermediate `/superadmin` URL, which
    // then client-redirects to `/superadmin/dashboard`. On the slower mobile
    // project the redirect is still in flight when the next goto fires, and
    // Playwright aborts it ("interrupted by another navigation"). Wait for the
    // redirect to settle before navigating to the salon detail page.
    await page
      .waitForURL(/\/superadmin\/dashboard(\/|$)/, { timeout: 30_000 })
      .catch(() => {});
    await page.goto(`/superadmin/salons/${salonId}`);

    // Panel appears.
    const panel = page.getByTestId("superadmin-salon-release-features");
    await expect(panel).toBeVisible();

    // "not billing" copy.
    await expect(
      panel.getByTestId("release-features-billing-note"),
    ).toHaveText("Release flags control product visibility, not billing.");

    // Three groups: Base, Beta, Plan / Column-controlled.
    await expect(panel.getByTestId("release-group-base")).toBeVisible();
    await expect(panel.getByTestId("release-group-beta")).toBeVisible();
    await expect(
      panel.getByTestId("release-group-plan_column"),
    ).toBeVisible();

    // Sample override badges: the two diverging seeded features.
    await expect(
      panel.getByTestId("release-override-group_booking"),
    ).toBeVisible();
    await expect(
      panel.getByTestId("release-override-receptionist_center"),
    ).toBeVisible();

    // Resolved state reflects the overrides on the feature rows.
    await expect(
      panel.getByTestId("release-feature-group_booking"),
    ).toHaveAttribute("data-resolved", "on");
    await expect(
      panel.getByTestId("release-feature-receptionist_center"),
    ).toHaveAttribute("data-resolved", "off");

    // A feature with no override carries no override badge.
    await expect(
      panel.getByTestId("release-feature-public_booking"),
    ).toBeVisible();
    await expect(
      panel.getByTestId("release-override-public_booking"),
    ).toHaveCount(0);
  });
});

const EDIT_SALON_SLUG = "e2e-release-features-editable";

let editAdmin: SeededSuperAdmin;
let editSalonId: string;

test.describe("SuperAdmin · editable release-features controls (PR4b-1)", () => {
  test.beforeAll(async () => {
    editAdmin = await seedTestSuperadmin({ role: "founder" });
    // Seed clean (no feature_flags overrides) so group_booking starts at its
    // Beta default OFF — the toggle then drives it ON.
    const seeded = await seedTestSalon({
      slug: EDIT_SALON_SLUG,
      name: "E2E Release Features Editable Salon",
      phone: "15550008888",
    });
    editSalonId = seeded.salonId;
  });

  test.afterAll(async () => {
    await cleanupTestSalon(EDIT_SALON_SLUG);
    if (editAdmin) await cleanupTestSuperadmin(editAdmin.userId);
  });

  test("toggle a jsonb feature ON, audit it, reset to default; plan/column stay read-only", async ({
    page,
  }) => {
    await loginAsSuperadmin(page, editAdmin);
    await gotoSalonDetail(page, editSalonId);

    const panel = page.getByTestId("superadmin-salon-release-features");
    await expect(panel).toBeVisible();

    const groupRow = panel.getByTestId("release-feature-group_booking");
    const toggle = panel.getByTestId("release-toggle-group_booking");

    // Starts at Beta default OFF, not overridden, with a toggle (editable).
    await expect(groupRow).toHaveAttribute("data-resolved", "off");
    await expect(groupRow).toHaveAttribute("data-editable", "true");
    await expect(toggle).toBeVisible();
    await expect(
      panel.getByTestId("release-override-group_booking"),
    ).toHaveCount(0);

    // Read-only sources expose NO toggle.
    await expect(
      panel.getByTestId("release-toggle-reviews"),
    ).toHaveCount(0); // plan-sourced
    await expect(
      panel.getByTestId("release-toggle-photos"),
    ).toHaveCount(0); // plan-sourced
    await expect(panel.getByTestId("release-toggle-ai_voice")).toHaveCount(0); // column
    await expect(
      panel.getByTestId("release-feature-ai_voice"),
    ).toHaveAttribute("data-editable", "false");

    // Toggle ON → resolved flips to ON + override badge appears (router.refresh).
    await toggle.click();
    await expect(groupRow).toHaveAttribute("data-resolved", "on", {
      timeout: 15_000,
    });
    await expect(
      panel.getByTestId("release-override-group_booking"),
    ).toBeVisible();

    // Audit row written with the new flag value.
    await expect
      .poll(
        async () => {
          const row = await getLatestAuditLog({
            actorUserId: editAdmin.userId,
            action: "salon_flags_set",
          });
          const flags = row?.after_jsonb?.feature_flags as
            | Record<string, unknown>
            | undefined;
          return flags?.group_booking_enabled;
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    // Reset to default → key removed, resolved returns to Beta default OFF,
    // override badge disappears.
    await panel.getByTestId("release-reset-group_booking").click();
    await expect(groupRow).toHaveAttribute("data-resolved", "off", {
      timeout: 15_000,
    });
    await expect(
      panel.getByTestId("release-override-group_booking"),
    ).toHaveCount(0);

    // Reset audit row: the merged feature_flags no longer carries the key.
    await expect
      .poll(
        async () => {
          const row = await getLatestAuditLog({
            actorUserId: editAdmin.userId,
            action: "salon_flags_set",
          });
          const flags = (row?.after_jsonb?.feature_flags ?? {}) as Record<
            string,
            unknown
          >;
          return Object.prototype.hasOwnProperty.call(
            flags,
            "group_booking_enabled",
          );
        },
        { timeout: 10_000 },
      )
      .toBe(false);
  });
});
