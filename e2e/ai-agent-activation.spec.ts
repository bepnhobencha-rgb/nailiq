import { expect, test, type Page } from "@playwright/test";

import {
  cleanupTestSalon,
  cleanupTestUser,
  getAiAgentPermissionSnapshot,
  invokeAiAgentPermission,
  seedTestSalon,
  seedTestSalonMember,
} from "./helpers/db";

const SLUG = `e2e-ai-agent-activation-${process.env.GITHUB_RUN_ID ?? Date.now()}`;
let salonId: string | undefined;
let owner:
  | Awaited<ReturnType<typeof seedTestSalonMember>>
  | undefined;

async function loginAs(
  page: Page,
  account: { email: string; password: string },
) {
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page.locator('input[inputmode="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });
}

async function openAiManagerCategory(page: Page) {
  const category = page.getByTestId("settings-category-cat-ai-manager");
  const toggle = category.locator(":scope > button");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("settings-ai-manager-hub")).toBeVisible();
}

test.describe("AI agent activation impact", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const salon = await seedTestSalon({
      slug: SLUG,
      name: "AI Agent Activation Test Salon",
      phone: "15553339992",
    });
    salonId = salon.salonId;
    owner = await seedTestSalonMember(salon.salonId, "owner");
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
    if (owner) await cleanupTestUser(owner.userId);
  });

  test("owner must explicitly confirm customer outreach before it persists", async ({
    page,
  }) => {
    if (!owner) throw new Error("owner fixture missing");
    await loginAs(page, owner);
    await page.goto(`/dashboard/${SLUG}/settings`);

    await openAiManagerCategory(page);
    const winback = page.getByRole("switch", { name: /Win-back|Kéo khách/ });
    await expect(winback).not.toBeChecked();
    await expect(
      page.locator('[data-impact="customer_outreach"]').first(),
    ).toBeVisible();

    page.once("dialog", (dialog) => dialog.dismiss());
    await winback.click();
    await expect(winback).not.toBeChecked();

    page.once("dialog", (dialog) => dialog.accept());
    await winback.click();
    await expect(winback).toBeChecked();
    await expect(winback).toBeEnabled();

    await page.reload();
    await openAiManagerCategory(page);
    const persistedWinback = page.getByRole("switch", {
      name: /Win-back|Kéo khách/,
    });
    await expect(persistedWinback).toBeChecked();

    await persistedWinback.click();
    await expect(persistedWinback).not.toBeChecked();
    await expect(persistedWinback).toBeEnabled();

    await page.reload();
    await openAiManagerCategory(page);
    await expect(
      page.getByRole("switch", { name: /Win-back|Kéo khách/ }),
    ).not.toBeChecked();

    const snapshot = await getAiAgentPermissionSnapshot(SLUG);
    expect(snapshot.audit).toMatchObject([
      {
        actor_user_id: owner.userId,
        actor_role: "owner",
        actor_kind: "member",
        flag_key: "ai_winback",
        impact: "customer_outreach",
        enabled: true,
        previous_enabled: false,
        impact_acknowledged: true,
      },
      {
        actor_user_id: owner.userId,
        actor_role: "owner",
        actor_kind: "member",
        flag_key: "ai_winback",
        impact: "customer_outreach",
        enabled: false,
        previous_enabled: true,
        impact_acknowledged: false,
      },
    ]);

    await page.goto(`/dashboard/${SLUG}/activity`);
    await page.getByTestId("activity-tab-ai").click();
    const disabledAuditRow = page
      .getByTestId("activity-row-ai")
      .filter({ hasText: /đã tắt Người Kéo Về — Win-back/ });
    await expect(disabledAuditRow).toBeVisible();
    await expect(
      disabledAuditRow.getByText("Có thể liên hệ trực tiếp với khách"),
    ).toBeVisible();
  });

  test("concurrent permission changes preserve both flags and audits", async () => {
    if (!owner || !salonId) throw new Error("permission fixtures missing");

    const enableResults = await Promise.all([
      invokeAiAgentPermission({
        salonId,
        actorUserId: owner.userId,
        flagKey: "ai_watchdog",
        enabled: true,
        impact: "monitoring",
      }),
      invokeAiAgentPermission({
        salonId,
        actorUserId: owner.userId,
        flagKey: "ai_social_content",
        enabled: true,
        impact: "draft_only",
      }),
    ]);
    expect(enableResults).toEqual([
      expect.objectContaining({ success: true, changed: true }),
      expect.objectContaining({ success: true, changed: true }),
    ]);

    let snapshot = await getAiAgentPermissionSnapshot(SLUG);
    expect(snapshot.featureFlags).toMatchObject({
      ai_watchdog: true,
      ai_social_content: true,
    });

    const disableResults = await Promise.all([
      invokeAiAgentPermission({
        salonId,
        actorUserId: owner.userId,
        flagKey: "ai_watchdog",
        enabled: false,
        impact: "monitoring",
      }),
      invokeAiAgentPermission({
        salonId,
        actorUserId: owner.userId,
        flagKey: "ai_social_content",
        enabled: false,
        impact: "draft_only",
      }),
    ]);
    expect(disableResults).toEqual([
      expect.objectContaining({ success: true, changed: true }),
      expect.objectContaining({ success: true, changed: true }),
    ]);

    snapshot = await getAiAgentPermissionSnapshot(SLUG);
    expect(snapshot.featureFlags).toMatchObject({
      ai_watchdog: false,
      ai_social_content: false,
    });
    const concurrentAudits = snapshot.audit.filter((row) =>
      ["ai_watchdog", "ai_social_content"].includes(row.flag_key),
    );
    expect(concurrentAudits).toHaveLength(4);
    expect(
      concurrentAudits.map((row) => [
        row.flag_key,
        row.previous_enabled,
        row.enabled,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["ai_watchdog", false, true],
        ["ai_social_content", false, true],
        ["ai_watchdog", true, false],
        ["ai_social_content", true, false],
      ]),
    );
  });
});
