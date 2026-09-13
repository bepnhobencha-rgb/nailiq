import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Browser state-machine tests: every API response is synthetic. No DB or provider calls.
const token = "12345678-1234-4234-8234-123456789abc";
const requestId = "12345678-1234-4234-8234-123456789abd";
const material = "a".repeat(64);
const uncertain = "We cannot yet confirm that your card was removed.";
const unavailable = "This link is no longer available.";
const origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3309";

test.beforeEach(async ({ context, request }) => {
  if (origin === "http://localhost:3309") return;
  const file = process.env.NAILIQ_QA_PREVIEW_ACCESS_FILE;
  if (!file || origin !== "https://nailiq-p0-signup-qa-20260911.vercel.app") throw new Error("QA access required");
  const access = readFileSync(file, "utf8").trim();
  if (new URL(access).origin !== origin) throw new Error("QA access host mismatch");
  try {
    await request.get(access);
    await context.addCookies((await request.storageState()).cookies);
  } catch { throw new Error("QA access bootstrap failed; private URL withheld"); }
});

async function pending(page: Page) {
  await page.addInitScript(async ({ token, requestId, material }) => {
    for (const [prefix, canonical, value] of [
      ["nailiq:booking-management-pending:", { v: 1, action: "card_manage", token }, { requestId, material, createdAt: Date.now() }],
      ["nailiq:booking-management:", { v: 1, action: "card_manage", token, material }, { requestId, createdAt: Date.now() }],
    ] as const) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(canonical)));
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      sessionStorage.setItem(prefix + hash, JSON.stringify(value));
    }
  }, { token, requestId, material });
}

async function setup(page: Page, response: { status: number; body?: unknown; abort?: boolean; raw?: string }) {
  let reads = 0;
  const writes: unknown[] = [];
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/api/booking/remove-card") {
      writes.push(route.request().postDataJSON());
      if (response.abort) return route.abort("failed");
      return route.fulfill({ status: response.status, contentType: "application/json",
        body: response.raw ?? JSON.stringify(response.body) });
    }
    if (url.pathname === "/api/booking/card-info") {
      reads++;
      return route.fulfill({ status: 404, json: { ok: false, code: "invalid_token" } });
    }
    if (url.pathname.startsWith("/api/")) return route.fulfill({ status: 200, json: {} });
    return route.continue();
  });
  return { reads: () => reads, writes };
}

for (const code of ["remove_unknown", "completion_write_uncertain", "in_flight", "provider_exception"]) {
  test(`reload preserves unresolved removal: ${code}`, async ({ page }) => {
    await pending(page);
    const calls = await setup(page, { status: code === "in_flight" ? 409 : 503, body: { ok: false, code } });
    await page.goto(`/booking/card?token=${token}`);
    await expect(page.locator("main").getByRole("alert")).toContainText(uncertain);
    await expect(page.locator("main").getByRole("alert")).toContainText("Vui lòng liên hệ salon");
    await expect(page.locator("main").getByRole("alert")).not.toContainText(code);
    await expect(page.getByText("Card removed ✓", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("remove-card-btn")).toHaveCount(0);
    expect(calls.reads()).toBe(0);
    expect(calls.writes).toEqual([{ token, requestId, expectedCardFingerprint: material }]);
    await page.reload();
    await expect(page.locator("main").getByRole("alert")).toContainText(uncertain);
    expect(calls.writes).toEqual(Array(2).fill({ token, requestId, expectedCardFingerprint: material }));
    expect(await page.evaluate(() => Object.keys(sessionStorage).some(k => k.startsWith("nailiq:booking-management-pending:")))).toBe(true);
    if (code === "remove_unknown") await page.screenshot({ path: `${process.env.NAILIQ_QA_ARTIFACT_DIR}/unknown-mobile.png`, fullPage: true });
  });
}

for (const [label, response] of [
  ["response loss", { status: 503, abort: true }],
  ["invalid JSON", { status: 503, raw: "broken" }],
  ["incomplete success", { status: 200, body: { ok: true } }],
  ["unrelated success", { status: 200, body: { ok: true, code: "saved" } }],
] as const) {
  test(`pending removal does not claim success: ${label}`, async ({ page }) => {
    await pending(page);
    const calls = await setup(page, response);
    await page.goto(`/booking/card?token=${token}`);
    await expect(page.locator("main").getByRole("alert")).toContainText(uncertain);
    expect(calls.reads()).toBe(0);
    await expect(page.getByText("Card removed ✓", { exact: true })).toHaveCount(0);
  });
}

for (const code of ["expired_or_revoked", "invalid_token", "expired_token"]) {
  test(`unavailable link is explicit: ${code}`, async ({ page }) => {
    await pending(page);
    const calls = await setup(page, { status: 404, body: { ok: false, code } });
    await page.goto(`/booking/card?token=${token}`);
    await expect(page.locator("main").getByRole("alert")).toContainText(unavailable);
    await expect(page.locator("main").getByRole("alert")).toContainText("new secure link");
    expect(calls.reads()).toBe(0);
  });
}

for (const code of ["removed", "already_removed"]) {
  test(`valid receipt clears pending intent: ${code}`, async ({ page }) => {
    await pending(page);
    const calls = await setup(page, { status: 200, body: { ok: true, code, idempotent: true } });
    await page.goto(`/booking/card?token=${token}`);
    await expect(page.getByText("Card removed ✓", { exact: true })).toBeVisible();
    expect(calls.reads()).toBe(0);
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith("nailiq:booking-management")))).toEqual([]);
  });
}

test("fresh unavailable link does not issue a removal", async ({ page }) => {
  const calls = await setup(page, { status: 503, body: { ok: false } });
  await page.goto(`/booking/card?token=${token}`);
  await expect(page.locator("main").getByRole("alert")).toContainText(unavailable);
  expect(calls.reads()).toBe(1);
  expect(calls.writes).toEqual([]);
});

test("fresh read outage does not imply a removal was attempted", async ({ page }) => {
  const calls = await setup(page, { status: 503, body: { ok: false } });
  await page.route("**/api/booking/card-info?**", route => route.fulfill({
    status: 503, json: { ok: false, code: "card_management_unavailable" },
  }));
  await page.goto(`/booking/card?token=${token}`);
  await expect(page.locator("main").getByRole("alert")).toContainText("We could not load your card information.");
  await expect(page.locator("main").getByRole("alert")).not.toContainText(uncertain);
  expect(calls.writes).toEqual([]);
});

for (const [label, response, succeeds] of [
  ["unknown", { status: 503, body: { ok: false, code: "remove_unknown" } }, false],
  ["response loss", { status: 503, abort: true }, false],
  ["incomplete success", { status: 200, body: { ok: true } }, false],
  ["confirmed", { status: 200, body: { ok: true, code: "removed" } }, true],
] as const) {
  test(`customer removal and reload: ${label}`, async ({ page }) => {
    const calls = await setup(page, response);
    await page.route("**/api/booking/card-info?**", route => route.fulfill({ status: 200, json: {
      ok: true, salonName: "Synthetic QA Salon", hasCard: true, brand: "VISA", last4: "1111",
      feeLabel: "$20", status: "saved", cardFingerprint: material,
    } }));
    await page.goto(`/booking/card?token=${token}`);
    await page.getByTestId("remove-card-btn").click();
    if (succeeds) {
      await expect(page.getByText("Card removed ✓", { exact: true })).toBeVisible();
      expect(calls.writes).toHaveLength(1);
      return;
    }
    await expect(page.locator("main").getByRole("alert")).toContainText(uncertain);
    expect(calls.writes).toHaveLength(1);
    await page.reload();
    await expect(page.locator("main").getByRole("alert")).toContainText(uncertain);
    expect(calls.writes).toHaveLength(2);
    expect(calls.writes[1]).toEqual(calls.writes[0]);
    await expect(page.getByTestId("remove-card-btn")).toHaveCount(0);
  });
}
