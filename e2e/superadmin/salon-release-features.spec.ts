import { test, expect } from "@playwright/test";
import { cleanupTestSalon, seedTestSalon } from "../helpers/db";
import {
  cleanupTestSuperadmin,
  loginAsSuperadmin,
  seedTestSuperadmin,
  type SeededSuperAdmin,
} from "../helpers/superadmin";

/**
 * Read-only SuperAdmin "Release features (resolved)" panel
 * (`SalonReleaseFeaturesCard`) on `/superadmin/salons/[salonId]`.
 *
 * Seeds a salon with two overrides that diverge from the registry defaults —
 * a Beta feature forced ON (`group_booking_enabled`) and a Base feature forced
 * OFF (`receptionist_center_enabled`) — then asserts the panel renders, carries
 * the "not billing" copy, shows the three groups, and surfaces an override
 * badge for the diverging features. This card has no write controls, so the
 * spec only reads — it never toggles anything.
 */

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
