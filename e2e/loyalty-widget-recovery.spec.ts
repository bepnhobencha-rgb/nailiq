import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { cleanupTestSalon, cleanupTestUser, seedTestSalonMember } from "./helpers/db";
import { seedReceptionistCenterFixture } from "./receptionist-center/helpers";

let slug: string;
let owner: Awaited<ReturnType<typeof seedTestSalonMember>>;

type LoadProbe = {
  attempts: number;
  errors: string[];
  settled: boolean;
  reject?: () => void;
};
type ProbeWindow = Window & { __loyaltyLoad?: LoadProbe };

function actionId(name: string) {
  const manifest = JSON.parse(readFileSync(".next/server/server-reference-manifest.json", "utf8")) as {
    node: Record<string, { exportedName?: string; filename?: string }>;
  };
  const id = Object.entries(manifest.node).find(([, entry]) =>
    entry.exportedName === name && entry.filename === "src/shared/loyalty/loyaltyActions.ts"
  )?.[0];
  expect(id, "Build the local app before testing action transport failures").toBeTruthy();
  return id!;
}

async function injectReadFailure(page: Page, action: string, hold = false) {
  await page.addInitScript(({ id, hold }) => {
    const state: LoadProbe = { attempts: 0, errors: [], settled: false };
    (window as ProbeWindow).__loyaltyLoad = state;
    window.addEventListener("error", event => state.errors.push(event.message));
    window.addEventListener("unhandledrejection", event => state.errors.push(String(event.reason)));
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.headers.get("next-action") === id) {
        state.attempts += 1;
        if (hold || state.attempts === 2) {
          return new Promise<Response>((_, reject) => {
            state.reject = () => reject(new TypeError("QA loyalty read interrupted"));
          }).finally(() => { state.settled = true; });
        }
        if (state.attempts === 1) throw new TypeError("QA loyalty read interrupted");
      }
      return originalFetch(input, init);
    };
  }, { id: actionId(action), hold });
}

async function signIn(page: Page, language: "en" | "vi") {
  await page.context().addCookies([{ name: "nailiq-user-lang", value: language, url: "http://localhost:3000" }]);
  await page.addInitScript(lang => {
    // Teardown opens about:blank, where localStorage is intentionally unavailable.
    if (location.origin === "http://localhost:3000") localStorage.setItem("nailiq-user-lang", lang);
  }, language);
  const digest = createHash("sha256").update(owner.email).digest("hex");
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `2001:db8::${digest.slice(0, 4)}:${digest.slice(4, 8)}` });
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute("data-hydrated", "true");
  await page.locator('input[inputmode="email"]').fill(owner.email);
  await page.locator('input[type="password"]').fill(owner.password);
  await page.getByTestId("password-signin-submit").click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/${slug}$`));
  expect((await page.context().cookies()).map(cookie => cookie.name)).not.toContain("nailiq-demo-slug");
}

test.beforeEach(async ({}, info) => {
  slug = `e2e-loyalty-load-${info.project.name}-${Date.now()}`;
  // An empty salon renders the first-booking share screen, which has no widget.
  const { salonId } = await seedReceptionistCenterFixture(slug);
  owner = await seedTestSalonMember(salonId, "owner");
});

test.afterEach(async ({ page }, info) => {
  try {
    const probe = await page.evaluate(() => (window as ProbeWindow).__loyaltyLoad).catch(() => null);
    await info.attach("loyalty-load-probe", { body: JSON.stringify(probe), contentType: "application/json" });
    await page.goto("about:blank");
  } finally {
    try { await cleanupTestSalon(slug); }
    finally { if (owner) await cleanupTestUser(owner.userId); }
  }
});

for (const { action, language } of [
  { action: "getLoyaltyProgram", language: "en" },
  { action: "getLoyaltyProgram", language: "vi" },
  { action: "getLoyaltyStats", language: "en" },
  { action: "getLoyaltyStats", language: "vi" },
] as const) {
  test(`${action} ${language}: failed read stays retryable and does not imply no program`, async ({ page, isMobile }, info) => {
    if (isMobile && language === "vi") await page.setViewportSize({ width: 320, height: 568 });
    await injectReadFailure(page, action);
    await signIn(page, language);
    await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__loyaltyLoad?.attempts)).toBe(1);
    const alert = page.getByRole("alert").filter({ hasText: language === "vi" ? "Chưa tải được thông tin tích điểm" : "Unable to load loyalty information" });
    const retry = page.getByRole("button", { name: language === "vi" ? "Thử tải lại tích điểm" : "Retry loyalty load" });
    await expect(alert).toBeVisible();
    await expect(page.getByText("No program configured.", { exact: false })).toHaveCount(0);
    await retry.click();
    await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__loyaltyLoad?.attempts)).toBe(2);
    await expect(retry).toBeDisabled();
    await expect(retry).toHaveAttribute("aria-busy", "true");
    await page.evaluate(() => (window as ProbeWindow).__loyaltyLoad!.reject!());
    await expect(retry).toBeEnabled();
    await expect(alert).toBeVisible();
    await alert.evaluate(el => el.scrollIntoView({ block: "center" }));
    await expect.poll(() => alert.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return [[rect.x + 8, rect.y + 8], [rect.right - 8, rect.bottom - 8], [rect.right - 8, rect.y + rect.height / 2]]
        .every(([x, y]) => el.contains(document.elementFromPoint(x, y)));
    })).toBe(true);
    await alert.screenshot({ path: info.outputPath("loyalty-load-retry.png") });
    const retryBox = await retry.boundingBox();
    expect(retryBox).not.toBeNull();
    expect(retryBox!.height).toBeGreaterThanOrEqual(44);
    expect(retryBox!.x).toBeGreaterThanOrEqual(0);
    expect(retryBox!.x + retryBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await retry.click();
    await expect(page.getByText("No program configured.", { exact: false })).toBeVisible();
    await expect(alert).toHaveCount(0);
    expect(await page.evaluate(() => (window as ProbeWindow).__loyaltyLoad?.attempts)).toBe(3);
    expect(await page.evaluate(() => (window as ProbeWindow).__loyaltyLoad?.errors)).toEqual([]);
  });
}

test("leaving the dashboard before a loyalty read rejects does not leak an unhandled rejection", async ({ page }) => {
  await injectReadFailure(page, "getLoyaltyProgram", true);
  await signIn(page, "en");
  await expect.poll(() => page.evaluate(() => typeof (window as ProbeWindow).__loyaltyLoad?.reject)).toBe("function");
  await page.locator(`a[href="/dashboard/${slug}/clients"]`).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/${slug}/clients$`));
  await expect(page.getByTestId("client-profiles-search")).toBeVisible();
  await page.evaluate(() => (window as ProbeWindow).__loyaltyLoad!.reject!());
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).__loyaltyLoad?.settled)).toBe(true);
  // Let the browser's unhandledrejection event turn run after the rejected read.
  await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 100)));
  expect(await page.evaluate(() => (window as ProbeWindow).__loyaltyLoad?.errors)).toEqual([]);
});
