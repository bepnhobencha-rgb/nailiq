import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { cleanupTestSalon, cleanupTestUser, seedTestUser } from "./helpers/db";
import { seedReceptionistCenterFixture, supabaseAdmin as db } from "./receptionist-center/helpers";

for (const value of [process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.PLAYWRIGHT_BASE_URL!]) {
  if (!["localhost", "127.0.0.1"].includes(new URL(value).hostname)) throw new Error("Management authority requires disposable loopback QA");
}
if (process.env.NAILIQ_DISPOSABLE_DB !== "1" || process.env.DEMO_OTP !== "false"
  || ["DISABLE_OUTBOUND_SMS", "DISABLE_OUTBOUND_EMAIL", "DISABLE_OUTBOUND_CALLS"].some((key) => process.env[key] !== "1")) {
  throw new Error("Management authority requires real Auth with outbound disabled");
}
const roles = ["owner", "admin", "senior", "receptionist", "nail_tech"] as const;
async function action(page: Page, name: string, slug: string, args: unknown[]) {
  const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")) as {
    node: Record<string, { exportedName?: string }>;
  };
  const id = Object.entries(manifest.node).find(([, entry]) => entry.exportedName === name)?.[0];
  expect(id, `built ${name} action`).toBeTruthy();
  const result = await page.evaluate(async ({ id, slug, args }) => {
    const response = await fetch(`/dashboard/${slug}`, {
      method: "POST",
      headers: { "next-action": id!, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component" },
      body: JSON.stringify(args),
    });
    const body = await response.text();
    const line = body.split("\n").find((line) => /^\w+:\{"ok":/.test(line));
    return { status: response.status, result: line ? JSON.parse(line.slice(line.indexOf(":") + 1)) : null };
  }, { id, slug, args });
  expect(result.status).toBe(200);
  expect(result.result, `${name} must return a structured receipt`).not.toBeNull();
  return result.result;
}
async function snapshot(salonId: string) {
  const q = await db.from("salons").select("id,brand_color,tax_lines,subscription_plan").eq("id", salonId).single();
  expect(q.error).toBeNull();
  return q.data;
}
for (const role of roles) {
  test(`${role}: settings deep-link and real actions enforce salon/role boundaries`, async ({ page }) => {
    const a = await seedReceptionistCenterFixture(`e2e-p003-mgmt-a-${randomUUID()}`);
    const b = await seedReceptionistCenterFixture(`e2e-p003-mgmt-b-${randomUUID()}`);
    const user = await seedTestUser();
    try {
      const grant = await db.from("salon_members").insert({ salon_id: a.salonId, user_id: user.userId, role });
      expect(grant.error).toBeNull();
      await page.goto("/register");
      await expect(page.getByTestId("social-auth-controls")).toHaveAttribute("data-hydrated", "true");
      await page.locator('input[inputmode="email"]').fill(user.email);
      await page.locator('input[type="password"]').fill(user.password);
      await page.getByTestId("password-signin-submit").click();
      await page.waitForURL(/\/dashboard\//);
      const allowed = role === "owner" || role === "admin";
      await page.goto(`/dashboard/${a.slug}/settings`, { waitUntil: "domcontentloaded" });
      if (allowed) {
        expect(new URL(page.url()).pathname).toBe(`/dashboard/${a.slug}/settings`);
        await expect(page.locator('[data-testid="settings-desktop-overview"], [data-testid="settings-mobile-list"]').filter({ visible: true }).first()).toBeVisible();
      } else {
        await expect(page).toHaveURL(new URL(`/dashboard/${a.slug}`, process.env.PLAYWRIGHT_BASE_URL!).href);
      }
      const before = await snapshot(a.salonId);
      const otherBefore = await snapshot(b.salonId);
      const taxes = [{ name: "QA synthetic tax", rate: 0.05, enabled: true }];
      const read = await action(page, "loadTaxSettings", a.slug, [a.slug]);
      expect(read.ok).toBe(allowed);
      const write = await action(page, "saveTaxSettings", a.slug, [a.slug, taxes]);
      expect(write.ok).toBe(allowed);
      const brand = await action(page, "updateBrandColor", a.slug, [a.slug, "#123456"]);
      expect(brand.ok).toBe(allowed);
      const after = await snapshot(a.salonId);
      if (allowed) {
        expect(after?.tax_lines).toEqual(taxes);
        expect(after?.brand_color).toBe("#123456");
        expect(after?.subscription_plan).toBe(before?.subscription_plan);
      } else expect(after).toEqual(before);
      // Forge only the action argument; retain the caller's own dashboard URL.
      for (const [name, args] of [
        ["loadTaxSettings", [b.slug]],
        ["saveTaxSettings", [b.slug, taxes]],
        ["updateBrandColor", [b.slug, "#654321"]],
      ] as const) {
        expect((await action(page, name, a.slug, [...args])).ok).toBe(false);
      }
      expect(await snapshot(b.salonId)).toEqual(otherBefore);
      await page.goto("/superadmin/dashboard", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
    } finally {
      try {
        if (!page.isClosed()) await page.goto("about:blank");
      } finally {
        await cleanupTestSalon(a.slug);
        await cleanupTestSalon(b.slug);
        await cleanupTestUser(user.userId);
      }
    }
  });
}
