import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";

const origin = "http://127.0.0.1:3116";
type Intent = { token: string; requestId: string };

async function transport(context: BrowserContext, reply: (route: Route, intent: Intent) => Promise<void>) {
  const intents: Intent[] = [];
  let external = 0;
  let otherMutation = 0;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { external++; return route.abort(); }
    if (["GET", "HEAD"].includes(request.method())) return route.continue();
    if (request.method() !== "POST" || url.pathname !== "/api/booking/waitlist-claim") {
      otherMutation++; return route.abort();
    }
    const intent = request.postDataJSON() as Intent;
    expect(Object.keys(intent).sort()).toEqual(["requestId", "token"]);
    expect(intent.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    intents.push(intent);
    await reply(route, intent);
  });
  return { intents, assertSafe: () => { expect(external).toBe(0); expect(otherMutation).toBe(0); } };
}

async function geometry(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  const button = page.getByRole("button");
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  expect(box?.width).toBeGreaterThanOrEqual(44);
  await expect(button).toBeInViewport({ ratio: 1 });
}

test.beforeEach(async ({ page }) => {
  // Every hydration/runtime failure fails the test, rather than a screenshot
  // being accepted merely because the server returned HTML.
  page.on("pageerror", (error) => { throw error; });
});

for (const outcome of ["booked", "claimed"] as const) {
  test(`normal ${outcome}: explicit keyboard confirmation and no POST after acknowledgement reload`, async ({ page, context }) => {
    const guard = await transport(context, (route) => route.fulfill({ json: { ok: true, outcome } }));
    await page.goto("/claim", { waitUntil: "networkidle" });
    expect(guard.intents).toHaveLength(0);
    await geometry(page);
    await page.getByRole("button", { name: "Claim this spot", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Confirmed", exact: true })).toBeVisible();
    await expect(page.getByText(outcome === "booked" ? /Your appointment is booked/ : /Your spot is reserved/)).toBeVisible();
    expect(guard.intents).toHaveLength(1);
    await page.goto("/claim?available=0", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Slot unavailable" })).toBeVisible();
    await expect(page.getByRole("button")).toHaveCount(0);
    expect(guard.intents).toHaveLength(1);
    guard.assertSafe();
  });
}

for (const failure of ["network", "http503"] as const) {
  test(`${failure}: reload and a second lost response keep one logical intent until explicit recovery`, async ({ page, context }, testInfo) => {
    // Simulated durable response, NOT a real DB receipt. B54 proves that layer.
    const receipts = new Map<string, string>();
    let attempts = 0;
    const guard = await transport(context, async (route, intent) => {
      receipts.set(intent.requestId, "booked");
      if (++attempts < 3) {
        if (failure === "network") return route.abort("failed");
        return route.fulfill({ status: 503, json: { ok: false } });
      }
      return route.fulfill({ json: { ok: true, outcome: receipts.get(intent.requestId) } });
    });
    await page.goto("/claim", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Claim this spot", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Please try again" })).toBeVisible();
    expect(guard.intents).toHaveLength(1);
    await page.goto("/claim?available=0", { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Check previous claim", exact: true })).toBeVisible();
    expect(guard.intents).toHaveLength(1);
    await geometry(page);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(axe.violations).toEqual([]);
    await testInfo.attach("recovery-layout", { body: await page.screenshot(), contentType: "image/png" });
    await page.getByRole("button", { name: "Check previous claim", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Please try again" })).toBeVisible();
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "Check previous claim", exact: true })).toBeVisible();
    expect(guard.intents).toHaveLength(2);
    await page.getByRole("button", { name: "Check previous claim", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Confirmed", exact: true })).toBeVisible();
    expect(guard.intents).toHaveLength(3);
    expect(new Set(guard.intents.map((intent) => intent.requestId)).size).toBe(1);
    expect(receipts.size).toBe(1);
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Slot unavailable" })).toBeVisible();
    await expect(page.getByRole("button")).toHaveCount(0);
    expect(guard.intents).toHaveLength(3);
    guard.assertSafe();
  });
}

for (const status of [400, 409]) {
  test(`terminal ${status}: private unavailable and no recovery after reload`, async ({ page, context }) => {
    const guard = await transport(context, (route) => route.fulfill({ status, json: { ok: false } }));
    await page.goto("/claim");
    await page.getByRole("button", { name: "Claim this spot", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Slot unavailable" })).toBeVisible();
    await page.goto("/claim?available=0", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Slot unavailable" })).toBeVisible();
    await expect(page.getByRole("button")).toHaveCount(0);
    expect(guard.intents).toHaveLength(1);
    guard.assertSafe();
  });
}

test("malformed success is not Confirmed and explicit retry retains the intent", async ({ page, context }) => {
  let count = 0;
  const guard = await transport(context, (route) => route.fulfill({
    json: ++count === 1 ? { ok: true, outcome: "unknown" } : { ok: true, outcome: "claimed" },
  }));
  await page.goto("/claim");
  await page.getByRole("button", { name: "Claim this spot", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Please try again" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Confirmed", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Confirmed", exact: true })).toBeVisible();
  expect(guard.intents).toHaveLength(2);
  expect(guard.intents[0]).toEqual(guard.intents[1]);
  guard.assertSafe();
});

test("rapid double activation locks the button until the response returns", async ({ page, context }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const guard = await transport(context, async (route) => {
    await gate;
    await route.fulfill({ json: { ok: true, outcome: "booked" } });
  });
  try {
    await page.goto("/claim");
    await page.getByRole("button", { name: "Claim this spot", exact: true }).dblclick();
    await expect.poll(() => guard.intents.length).toBe(1);
    const busy = page.getByRole("button", { name: "Claiming…", exact: true });
    await expect(busy).toBeDisabled();
    await expect(busy).toHaveAttribute("aria-busy", "true");
    release();
    await expect(page.getByRole("heading", { name: "Confirmed", exact: true })).toBeVisible();
    expect(guard.intents).toHaveLength(1);
    guard.assertSafe();
  } finally { release(); }
});

test("an unavailable offer with no pending intent cannot create one", async ({ page, context }) => {
  const guard = await transport(context, (route) => route.abort());
  await page.goto("/claim?available=0", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Slot unavailable" })).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("button")).toHaveCount(0);
  expect(guard.intents).toHaveLength(0);
  guard.assertSafe();
});

test("another token cannot recover this token's unacknowledged request", async ({ page, context }) => {
  const guard = await transport(context, (route) => route.abort("failed"));
  await page.goto("/claim");
  await page.getByRole("button", { name: "Claim this spot", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Please try again" })).toBeVisible();
  await page.goto("/claim?available=0&other=1", { waitUntil: "networkidle" });
  await expect(page.getByRole("button")).toHaveCount(0);
  await page.goto("/claim?available=0", { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "Check previous claim", exact: true })).toBeVisible();
  expect(guard.intents).toHaveLength(1);
  guard.assertSafe();
});

test("storage denied fails closed without a POST or false success", async ({ page, context }) => {
  await context.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("Synthetic storage denied", "SecurityError"); };
  });
  const guard = await transport(context, (route) => route.abort());
  await page.goto("/claim?available=0", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Slot unavailable" })).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
  await page.goto("/claim");
  await page.getByRole("button", { name: "Claim this spot", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Please try again" })).toBeVisible();
  expect(guard.intents).toHaveLength(0);
  guard.assertSafe();
});
