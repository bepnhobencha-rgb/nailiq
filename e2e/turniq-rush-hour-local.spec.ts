import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const PATH = "/e2e-local/turniq-rush-hour";

test.describe("TurnIQ M6 60-second comprehension and rush-hour demo", () => {
  test("a first-time owner identifies next, why, wait and owner action at a glance", async ({ page }) => {
    const startedAt = Date.now();
    await page.goto(PATH);
    await expect(page.getByText("Synthetic TurnIQ M6 · Salon A · 12 technicians")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tech 06" })).toBeVisible();
    await expect(page.getByText(/Staff-entered request/)).toBeVisible();
    await expect(page.getByText("Wait 0–10 min")).toBeVisible();
    await expect(page.getByText("No owner action needed")).toBeVisible();
    await expect(page.getByText("INSUFFICIENT_APPOINTMENT_GAP")).toBeVisible();
    expect(Date.now() - startedAt).toBeLessThan(60_000);
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  });

  test("completes the scripted trust story with one receipt, replay and exact-once reconnect", async ({ page }) => {
    await page.goto(PATH);
    await page.getByRole("button", { name: /Add walk-in/ }).click();
    await expect(page.getByText("Walk-in assigned in 8 seconds")).toBeVisible();
    await page.getByRole("button", { name: "Complete service atomically" }).click();
    await expect(page.getByText(/Exactly 1 durable receipt/)).toBeVisible();
    await page.getByRole("button", { name: /fairness band/ }).click();
    await expect(page.getByText(/Read-only replay:/)).toBeVisible();
    await page.getByRole("button", { name: "Lose Internet and continue" }).click();
    await expect(page.getByText(/1 encrypted IndexedDB command persisted/)).toBeVisible();
    await page.reload();
    await expect(page.getByText(/1 encrypted IndexedDB command persisted/)).toBeVisible();
    await expect(page.getByText(/Exactly 1 durable receipt/)).toBeVisible();
    await page.getByRole("button", { name: "Reconnect and sync" }).click();
    await expect(page.getByText(/1 unique command · 0 lost · 0 duplicate/)).toBeVisible();
  });

  test("the trust board remains readable on a salon tablet and has no serious accessibility violations", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto(PATH);
    await expect(page.getByRole("heading", { name: "Tech 06" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Add walk-in/ })).toBeInViewport();
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(results.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious"))
      .toEqual([]);
  });

  test("a missing encryption key fails closed after reload", async ({ page }) => {
    await page.goto(PATH);
    await page.getByRole("button", { name: /Add walk-in/ }).click();
    await page.getByRole("button", { name: "Complete service atomically" }).click();
    await page.getByRole("button", { name: "Lose Internet and continue" }).click();
    await expect(page.getByText(/encrypted IndexedDB/)).toBeVisible();
    await page.evaluate(async () => {
      const request = indexedDB.open("nailiq-turniq-offline-v1", 1);
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction("keys", "readwrite");
      transaction.objectStore("keys").delete("outbox-aes-gcm");
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
    });
    await page.reload();
    await expect(page.getByRole("alert").filter({ hasText: "Offline storage corruption detected" }))
      .toBeVisible();
    await expect(page.getByRole("button", { name: /Add walk-in/ })).toBeDisabled();
  });

  test("the cached shell opens the encrypted board when the origin disappears", async ({ page, context, browserName }) => {
    test.skip(
      process.env.TURNIQ_PRODUCTION_SHELL_TEST !== "1",
      "A dev build requires an uncached HMR client; offline shell proof must run against next build/start.",
    );
    test.skip(
      browserName === "webkit",
      "Playwright WebKit aborts offline navigation internally; the iOS/Safari device check remains a manual pilot gate.",
    );
    await page.goto(PATH);
    await page.getByRole("button", { name: /Add walk-in/ }).click();
    await page.getByRole("button", { name: "Complete service atomically" }).click();
    await page.getByRole("button", { name: "Lose Internet and continue" }).click();
    await page.waitForFunction(async () => {
      await navigator.serviceWorker.ready;
      const cache = await caches.open("nailiq-turniq-offline-shell-v1");
      return Boolean(navigator.serviceWorker.controller) &&
        Boolean(await cache.match("/turniq/offline"));
    });
    await context.setOffline(true);
    try {
      await page.goto("/dashboard/synthetic-salon/center");
      await expect(page.getByRole("heading", { name: "Tiếp tục ca làm an toàn" })).toBeVisible();
      await expect(page.getByText(/1 thao tác chưa đồng bộ/)).toBeVisible();
      await expect(page.getByText(/Không SMS\/email, thanh toán hay đổi lịch cloud/)).toBeVisible();
      await page.getByLabel("Đổi sang thợ").selectOption({ label: "Tech 07" });
      await page.getByLabel("Lý do bắt buộc").fill("Customer requested Tech 07 in person");
      await page.getByRole("button", { name: "Lưu override" }).click();
      await expect(page.getByText(/2 thao tác chưa đồng bộ/)).toBeVisible();
      await page.reload();
      await expect(page.getByText(/2 thao tác chưa đồng bộ/)).toBeVisible();
      await expect(page.getByText(/confirmed/)).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });
});
