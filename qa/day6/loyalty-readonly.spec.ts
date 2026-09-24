import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { cleanupTestSalon, cleanupTestUser, seedTestSalonMember } from "../../e2e/helpers/db";
import { seedReceptionistCenterFixture, supabaseAdmin } from "../../e2e/receptionist-center/helpers";
import { loginReceptionist } from "../../e2e/receptionist-center/realReceptionist";
import { seedReadOnlyLoyalty, cleanupReadOnlyLoyalty } from "./loyalty-fixture";

test.use({ serviceWorkers: "block" });
let fx: Awaited<ReturnType<typeof seedReceptionistCenterFixture>>;
let member: Awaited<ReturnType<typeof seedTestSalonMember>>;
let restore: (() => Promise<void>) | undefined;
test.beforeAll(async ({}, info) => {
  fx = await seedReceptionistCenterFixture(`e2e-loyalty-readonly-${randomUUID()}`);
  member = await seedTestSalonMember(fx.salonId, info.project.name.includes("admin") ? "admin" : "owner");
  restore = await seedReadOnlyLoyalty(fx.salonId);
});
test.afterAll(async () => {
  try { if (member) await cleanupTestUser(member.userId); }
  finally {
    try {
      if (fx) {
        await cleanupReadOnlyLoyalty(fx.salonId);
        await cleanupTestSalon(fx.slug, { clearAllRateLimits: false });
      }
    }
    finally { await restore?.(); }
  }
});

test("configured loyalty is honestly read-only and lookup recovers without changing balances", async ({ page, context }, info) => {
  const vi = info.project.name.endsWith("vi");
  const language = vi ? "vi" : "en";
  const origin = "http://127.0.0.1:3117";
  await context.addCookies([{ name: "nailiq-user-lang", value: language, url: origin }]);
  await context.route("**/*", route => [origin, "http://127.0.0.1:54321"].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort());
  await page.addInitScript(({ language, origin }) => { if (location.origin === origin) localStorage.setItem("nailiq-user-lang", language); }, { language, origin });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await loginReceptionist(page, member);
  await expect(page.getByTestId("owner-mobile-staff-status")).toBeVisible();
  const phone = page.getByRole("textbox", { name: vi ? "Số điện thoại khách hàng" : "Customer phone number" });
  const lookup = page.getByRole("button", { name: vi ? "Tra cứu" : "Look up", exact: true });
  await phone.fill("+16045550148");
  await lookup.click();
  await expect(page.getByText("QA Rewards", { exact: true })).toBeVisible();
  await expect.soft(page.getByText(vi ? "3/10 điểm" : "3/10 stamps", { exact: true })).toBeVisible();
  await expect.soft(page.getByRole("button", { name: vi ? "+1 điểm" : "+1 stamp", exact: true })).toBeDisabled();
  await expect.soft(page.getByRole("button", { name: vi ? "−1 điểm" : "−1 stamp", exact: true })).toBeDisabled();
  await expect.soft(page.getByText(vi ? "Chỉ xem: hiện chưa hỗ trợ cộng, trừ điểm hoặc đổi quà." : "Read only: adding or removing stamps and redeeming rewards are currently unavailable.", { exact: true })).toBeVisible();

  // A route refresh must not remount the independent loyalty lookup.
  // A synthetic program rename proves keeping the form does not freeze reads.
  const rename = await supabaseAdmin.from("loyalty_programs").update({ name: "QA Rewards Updated" }).eq("salon_id", fx.salonId);
  expect(rename.error).toBeNull();
  await page.getByTestId("owner-refresh").click();
  await expect(page.getByTestId("owner-refresh")).toBeEnabled();
  await expect(phone).toHaveValue("+16045550148");
  await expect(page.getByText(vi ? "3/10 điểm" : "3/10 stamps", { exact: true })).toBeVisible();
  await expect(page.getByText("QA Rewards Updated", { exact: true })).toBeVisible();
  const resetName = await supabaseAdmin.from("loyalty_programs").update({ name: "QA Rewards" }).eq("salon_id", fx.salonId);
  expect(resetName.error).toBeNull();

  // Observe the real 30-second poll, not a mocked refresh or accelerated clock.
  // Keep an unfinished number focused: background work must not discard typing.
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8"));
  const actions = manifest.node as Record<string, { exportedName?: string }>;
  const refreshAction = Object.entries(actions).find(([, value]) => value.exportedName === "loadSalonOwnerDashboard")?.[0];
  expect(refreshAction).toBeTruthy();
  const refreshed = page.waitForResponse(response => response.request().headers()["next-action"] === refreshAction, { timeout: 40_000 });
  await phone.fill("+1604555");
  await phone.focus();
  const response = await refreshed;
  expect(response.ok()).toBe(true);
  await response.finished();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(phone).toHaveValue("+1604555");
  await expect(phone).toBeFocused();
  await phone.fill("+16045550149");
  await expect.soft(page.getByText("QA Rewards", { exact: true })).toHaveCount(0);
  await lookup.click();
  await expect(page.getByText(vi ? "7/10 điểm" : "7/10 stamps", { exact: true })).toBeVisible();
  await expect(page.getByText("QA Rewards", { exact: true })).toBeVisible();
  await phone.fill("+16045550150");
  await lookup.click();
  await expect(page.getByText(vi ? "Không tìm thấy thẻ cho số điện thoại này." : "No card found for this number.", { exact: true })).toBeVisible();
  const noCard = page.getByRole("status").filter({ hasText: vi ? "Không tìm thấy thẻ" : "No card found" });
  await noCard.scrollIntoViewIfNeeded();
  expect(await noCard.evaluate(element => {
    const box = element.getBoundingClientRect();
    return [0.1, 0.5, 0.9].every(fraction => {
      const hit = document.elementFromPoint(box.left + box.width * fraction, box.top + box.height / 2);
      return hit === element || element.contains(hit);
    });
  }), "Coco/navigation must not cover the no-card message").toBe(true);
  await expect(page.getByText("QA Rewards", { exact: true })).toHaveCount(0);

  // Inject failure only after all initial dashboard reads have completed.
  // Exact action identity prevents aborting presence/stats instead of lookup.
  const action = Object.entries(actions).find(([, value]) => value.exportedName === "getClientLoyaltyCard")?.[0];
  expect(action).toBeTruthy();
  let intercepted = 0;
  await page.route("**/*", async route => {
    if (route.request().headers()["next-action"] === action && intercepted === 0) {
      intercepted += 1;
      await route.fulfill({ status: 503, contentType: "text/plain", body: "Synthetic QA unavailable" });
    } else await route.fallback();
  });
  await phone.fill("+16045550148");
  await lookup.click();
  await expect.poll(() => intercepted).toBe(1);
  await expect(page.getByRole("alert").filter({ hasText: vi ? "Chưa tra cứu được thẻ. Vui lòng thử lại." : "Unable to look up the card. Please try again." })).toBeVisible();
  await lookup.click();
  await expect(page.getByText(vi ? "3/10 điểm" : "3/10 stamps", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const cards = await supabaseAdmin.from("loyalty_cards").select("stamps_current,stamps_lifetime").eq("salon_id", fx.salonId).order("client_phone");
  expect(cards.error).toBeNull();
  expect(cards.data).toEqual([{ stamps_current: 3, stamps_lifetime: 3 }, { stamps_current: 7, stamps_lifetime: 7 }]);
  const events = await supabaseAdmin.from("loyalty_stamp_events").select("id", { head: true, count: "exact" }).eq("salon_id", fx.salonId);
  expect(events.error).toBeNull();
  expect(events.count).toBe(0);
});
