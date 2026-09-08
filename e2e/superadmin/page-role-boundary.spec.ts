import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import { seedTestSalon, cleanupTestSalon } from "../helpers/db";
import { seedTestSuperadmin, cleanupTestSuperadmin, loginAsSuperadmin, type SuperAdminRole } from "../helpers/superadmin";

const roles: SuperAdminRole[] = ["founder", "ops_admin", "support_admin", "billing_admin", "ai_admin", "readonly_analyst"];
const readers: SuperAdminRole[] = ["founder", "ops_admin", "support_admin", "billing_admin"];
const operators: SuperAdminRole[] = ["founder", "ops_admin"];

for (const role of roles) {
  test(`${role}: direct pages enforce role authority after real sign-in`, async ({ page }, info) => {
    const slug = "e2e-page-role-" + randomUUID().slice(0, 8);
    const { salonId } = await seedTestSalon({ slug, name: "QA Page Authority", phone: "15555550197" });
    const account = await seedTestSuperadmin({ role });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const observations = [];
    const routes: { path: string; allowed: SuperAdminRole[] }[] = [
      { path: "dashboard", allowed: roles },
      { path: "salons", allowed: readers },
      { path: `salons/${salonId}`, allowed: readers },
      { path: "users", allowed: ["founder", "ops_admin", "support_admin"] },
      { path: "operations/feature-flags", allowed: operators },
      { path: "ai/costs", allowed: ["founder", "ai_admin"] },
      { path: "security", allowed: operators },
      { path: "settings", allowed: operators },
    ];
    try {
      await loginAsSuperadmin(page, account);
      // The sign-in helper waits for the dashboard URL. Let its RSC/prefetch
      // work settle before a full-document navigation can cancel that work.
      await page.waitForLoadState("networkidle");
      for (const route of routes) {
        const target = `/superadmin/${route.path}`;
        const response = await page.goto(target, { waitUntil: "networkidle" });
        const allowed = route.allowed.includes(role);
        const finalPath = new URL(page.url()).pathname;
        // A streamed Next.js notFound response can retain HTTP 200.
        const notFound = await page.getByRole("heading", { name: "404", exact: true }).isVisible();
        const denied = response?.status() === 403 || response?.status() === 404 || notFound || finalPath !== target;
        observations.push({ path: route.path.replace(salonId, ":salonId"), allowed, status: response?.status(), denied });
        expect.soft(response?.status(), target).toBeLessThan(500);
        expect.soft(denied, `${role}: ${target}`).toBe(!allowed);
        if (allowed && route.path === `salons/${salonId}`) {
          await expect(page.getByTestId("release-toggle-group_booking")).toHaveCount(operators.includes(role) ? 1 : 0);
        }
      }
      expect(errors).toEqual([]);
      await info.attach("route-authority", { body: JSON.stringify(observations, null, 2), contentType: "application/json" });
      await page.screenshot({ path: info.outputPath(`${role}-settings.png`), fullPage: true });
    } finally {
      await page.goto("about:blank");
      await cleanupTestSalon(slug);
      await cleanupTestSuperadmin(account.userId);
    }
  });
}
