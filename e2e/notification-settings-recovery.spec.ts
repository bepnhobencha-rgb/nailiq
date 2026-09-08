import { readFileSync } from "node:fs";
import { expect, test, type Page, type Locator } from "@playwright/test";
import { cleanupTestSalon, cleanupTestUser, seedTestSalon, seedTestSalonMember } from "./helpers/db";
import { supabaseAdmin as db } from "./receptionist-center/helpers";

const slug = "e2e-notification-settings-recovery";
const path = `/dashboard/${slug}/settings?section=notifications`;
const cards = [
  { id: "sms-template-experience-card", marker: "reminder_24h" },
  { id: "customer-channel-card", marker: "smsOutboundEnabled" },
  { id: "staff-notifications-card", marker: "eventDefaults" },
  { id: "owner-notifications-card", marker: "customEmails" },
] as const;
type CardId = typeof cards[number]["id"];
let salonId: string;
let owner: Awaited<ReturnType<typeof seedTestSalonMember>>;

async function openSettings(page: Page) {
  await page.goto(path);
  for (const card of cards) {
    await expect(page.getByTestId(card.id).getByRole("button", { name: /^(Lưu|Lưu cài đặt mẫu)$/ })).toBeEnabled();
  }
}

async function edit(card: Locator, id: CardId) {
  if (id === "sms-template-experience-card") await card.getByRole("switch", { name: "Nhắc lịch trước 24 giờ: on", exact: true }).click();
  if (id === "customer-channel-card") await card.getByTestId("channel-mode-email_only").check();
  if (id === "staff-notifications-card") await card.getByTestId("staff-notif-locale-vi").check();
  if (id === "owner-notifications-card") {
    await card.getByTestId("owner-notif-enabled").check();
    await card.getByTestId("owner-notif-emails").fill("qa-recovery@example.invalid");
  }
}

async function expectDraft(card: Locator, id: CardId) {
  if (id === "sms-template-experience-card") await expect(card.getByRole("switch", { name: "Nhắc lịch trước 24 giờ: off", exact: true })).toHaveAttribute("aria-checked", "false");
  if (id === "customer-channel-card") await expect(card.getByTestId("channel-mode-email_only")).toBeChecked();
  if (id === "staff-notifications-card") await expect(card.getByTestId("staff-notif-locale-vi")).toBeChecked();
  if (id === "owner-notifications-card") {
    await expect(card.getByTestId("owner-notif-enabled")).toBeChecked();
    await expect(card.getByTestId("owner-notif-emails")).toHaveValue("qa-recovery@example.invalid");
  }
}

async function readSaved(id: CardId) {
  if (id === "sms-template-experience-card") {
    const r = await db.from("salon_sms_template_settings").select("settings").eq("salon_id", salonId).maybeSingle();
    expect(r.error).toBeNull();
    return r.data?.settings?.reminder_24h === false;
  }
  const r = await db.from("salons").select("customer_channel,staff_notification_settings,default_notification_locale,owner_notification_settings,sms_outbound_enabled,email_outbound_enabled").eq("id", salonId).single();
  expect(r.error).toBeNull();
  // Every test keeps the salon's actual delivery gates OFF.
  expect(r.data!.sms_outbound_enabled).toBe(false);
  expect(r.data!.email_outbound_enabled).toBe(false);
  if (id === "customer-channel-card") return r.data!.customer_channel === "email_only";
  if (id === "staff-notifications-card") return r.data!.staff_notification_settings?.defaultLocale === "vi" && r.data!.default_notification_locale === "vi";
  return r.data!.owner_notification_settings?.enabled === true && r.data!.owner_notification_settings?.customEmails?.includes("qa-recovery@example.invalid");
}

test.beforeEach(async ({ page }) => {
  ({ salonId } = await seedTestSalon({ slug, name: "E2E Notification Settings Recovery", phone: "16045550167" }));
  owner = await seedTestSalonMember(salonId, "owner");
  await page.addInitScript(() => {
    if (location.protocol === "http:" || location.protocol === "https:") {
      localStorage.setItem("nailiq-user-lang", "vi");
    }
  });
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute("data-hydrated", "true");
  await page.locator('input[inputmode="email"]').fill(owner.email);
  await page.locator('input[type="password"]').fill(owner.password);
  await page.getByTestId("password-signin-submit").click();
  await expect(page).toHaveURL(/\/dashboard\//);
  await openSettings(page);
});

test.afterEach(async ({ page }) => {
  await page.context().setOffline(false);
  await page.goto("about:blank");
  await cleanupTestSalon(slug);
  if (owner) await cleanupTestUser(owner.userId);
});

for (const { id, marker } of cards) {
  for (const committed of [false, true]) {
    test(`${id}: ${committed ? "lost response after commit" : "offline before commit"} preserves draft and permits verified retry`, async ({ page }, info) => {
      const pageErrors: string[] = [];
      page.on("pageerror", error => pageErrors.push(error.stack || error.message));
      const card = page.getByTestId(id);
      await edit(card, id);
      expect(await readSaved(id)).toBeFalsy();
      const save = card.getByRole("button", { name: /^(Lưu|Lưu cài đặt mẫu)$/ });
      if (committed) {
        // Throw only after a real server response is fully received. This
        // simulates response loss without relying on WebKit request routing.
        await page.evaluate(({ marker, slug }) => {
          const originalFetch = window.fetch.bind(window);
          const state = window as typeof window & { __notificationResponseLost?: boolean };
          window.fetch = async (input, init) => {
            const request = new Request(input, init);
            const matches = request.method === "POST" &&
              new URL(request.url).pathname === `/dashboard/${slug}/settings` &&
              (await request.clone().text()).includes(marker);
            const response = await originalFetch(input, init);
            if (matches && response.ok && !state.__notificationResponseLost) {
              await response.clone().text();
              state.__notificationResponseLost = true;
              throw new TypeError("QA simulated response loss after HTTP 200");
            }
            return response;
          };
        }, { marker, slug });
      } else {
        await page.context().setOffline(true);
      }

      await save.click();
      if (committed) {
        await expect.poll(() => page.evaluate(() => (window as typeof window & { __notificationResponseLost?: boolean }).__notificationResponseLost)).toBe(true);
        expect(await readSaved(id)).toBe(true);
        await info.attach("commit-confirmed", { body: JSON.stringify({ card: id, saved: true, responseReceivedBeforeInjectedLoss: true }), contentType: "application/json" });
      } else {
        expect(await readSaved(id)).toBeFalsy();
      }
      await expect(card.getByRole("alert")).toContainText("Chưa xác nhận được kết quả lưu");
      await expect(page.getByRole("heading", { name: "Dashboard could not load" })).toHaveCount(0);
      await expectDraft(card, id);
      await expect(save).toBeEnabled();
      await card.screenshot({ path: info.outputPath("draft-preserved.png") });

      await page.context().setOffline(false);
      await save.click();
      await expect(card.getByRole("status").filter({ hasText: "Đã lưu." })).toBeVisible();
      await expect(card.getByRole("alert")).toHaveCount(0);
      expect(await readSaved(id)).toBe(true);
      await openSettings(page);
      await expectDraft(page.getByTestId(id), id);
      const operations = await db.from("booking_payment_operations").select("id").eq("salon_id", salonId);
      expect(operations.error).toBeNull();
      expect(operations.data).toEqual([]);
      expect(pageErrors).toEqual([]);
    });
  }
}

// Target the action by its exported name in the current local production build.
// This avoids brittle hashes and leaves every other settings read untouched.
test("group booking settings: failed background load blocks defaults and retries saved value", async ({ page }, info) => {
  const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")) as {
    node: Record<string, { exportedName?: string; filename?: string }>;
  };
  const actionId = Object.entries(manifest.node).find(([, action]) =>
    action.exportedName === "loadGroupBookingSettings" &&
    action.filename === "src/shared/booking/groupBookingSettingsActions.ts"
  )?.[0];
  expect(actionId, "Build the local app before this regression test").toBeTruthy();
  const saved = await db.from("salons").update({ group_decline_cutoff_hours: 12 }).eq("id", salonId);
  expect(saved.error).toBeNull();
  await page.addInitScript(({ actionId }) => {
    // Scope errors to the tested document. Navigating away can cancel pending
    // settings reads in the previous document, especially in WebKit.
    const state = window as typeof window & { __groupLoadErrors?: string[] };
    state.__groupLoadErrors = [];
    window.addEventListener("error", event => state.__groupLoadErrors!.push(event.message));
    window.addEventListener("unhandledrejection", event => state.__groupLoadErrors!.push(String(event.reason)));
    const originalFetch = window.fetch.bind(window);
    let failed = false;
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (!failed && request.headers.get("next-action") === actionId) {
        failed = true;
        throw new TypeError("QA group settings load disconnected");
      }
      return originalFetch(input, init);
    };
  }, { actionId });
  await page.goto(`/dashboard/${slug}/settings?section=booking`);
  await expect(page.getByRole("alert").filter({ hasText: "Chưa tải được cài đặt đặt nhóm" })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Số giờ tuỳ chỉnh" })).toHaveCount(0);
  const retry = page.getByRole("button", { name: "Thử tải lại cài đặt đặt nhóm" });
  await retry.screenshot({ path: info.outputPath("group-load-retry.png") });
  await retry.click();
  await expect(page.getByRole("spinbutton", { name: "Số giờ tuỳ chỉnh" })).toHaveValue("12");
  await expect(retry).toHaveCount(0);
  expect(await page.evaluate(() => (window as typeof window & { __groupLoadErrors?: string[] }).__groupLoadErrors)).toEqual([]);
});
