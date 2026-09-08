import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
import { seedTestSalon, cleanupTestSalon } from "../helpers/db";
import { seedTestSuperadmin, cleanupTestSuperadmin, loginAsSuperadmin, type SuperAdminRole } from "../helpers/superadmin";
import { supabaseAdmin as db } from "../receptionist-center/helpers";

// Page hiding alone is insufficient: send the actual built action over HTTP.
const roles: SuperAdminRole[] = ["founder", "ops_admin", "support_admin", "billing_admin", "ai_admin", "readonly_analyst"];
for (const role of roles) {
  test(`${role}: salon flag action enforces role and audit authority`, async ({ page }) => {
    const slug = "e2e-flag-role-" + randomUUID().slice(0, 8);
    const { salonId } = await seedTestSalon({ slug, name: "QA role boundary", phone: "15555550197" });
    const admin = await seedTestSuperadmin({ role });
    try {
      await loginAsSuperadmin(page, admin);
      const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")) as { node: Record<string, { exportedName?: string }> };
      const action = Object.entries(manifest.node).find(([, entry]) => entry.exportedName === "updateSalonFlags")?.[0];
      expect(action, "built updateSalonFlags action must exist").toBeTruthy();
      const before = await db.from("salons").select("feature_flags").eq("id", salonId).single();
      expect(before.error).toBeNull();
      const response = await page.evaluate(async ({ action, salonId }) => {
        const result = await fetch("/superadmin/dashboard", {
          method: "POST",
          headers: { "next-action": action!, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component" },
          body: JSON.stringify([salonId, { featureFlags: { group_booking_enabled: true } }]),
        });
        return result.text();
      }, { action, salonId });
      const after = await db.from("salons").select("feature_flags").eq("id", salonId).single();
      const audit = await db.from("superadmin_audit_logs").select("actor_role").eq("actor_user_id", admin.userId).eq("action", "salon_flags_set");
      expect(after.error).toBeNull(); expect(audit.error).toBeNull();
      if (role === "founder" || role === "ops_admin") {
        expect(response).toContain('"ok":true');
        expect(after.data?.feature_flags?.group_booking_enabled).toBe(true);
        expect(audit.data).toEqual([{ actor_role: role }]);
      } else {
        expect(response).toContain('"error":"forbidden"');
        expect(after.data).toEqual(before.data);
        expect(audit.data).toEqual([]);
      }
    } finally {
      await page.goto("about:blank");
      await cleanupTestSalon(slug);
      await cleanupTestSuperadmin(admin.userId);
    }
  });
}
