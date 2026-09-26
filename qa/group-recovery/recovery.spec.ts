import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:3129";
test.beforeEach(async ({ page }) => {
  await page.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
});
for (const lang of ["en", "vi"] as const) {
  const name = lang === "vi" ? "Họ tên của bạn" : "Your full name";
  const phone = lang === "vi" ? "Số điện thoại của bạn" : "Your phone number";
  test(`${lang}: own agreement, duplicate click, durable success`, async ({ page, context }) => {
    await page.goto(`/?lang=${lang}`);
    const button = page.getByTestId("replacement-accept");
    await expect(button).toBeDisabled();
    await page.getByLabel(name).fill("Synthetic QA Guest");
    await page.getByLabel(phone).fill("+16045550101");
    await page.getByRole("checkbox").check();
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await button.dblclick();
    await expect(page.getByTestId("replacement-accepted")).toBeVisible();
    expect((await context.cookies()).find(c => c.name === "qa-accept-count")?.value).toBe("1");
    await page.reload();
    await expect(page.getByTestId("replacement-accepted")).toBeVisible();
    await expect(page.getByTestId("replacement-accept")).toHaveCount(0);
  });
  test(`${lang}: uncertain outcome keeps same request and material`, async ({ page, context }) => {
    await context.addCookies([{ name: "qa-fault", value: "unknown", url: origin }]);
    await page.goto(`/?lang=${lang}`);
    await page.getByLabel(name).fill("Synthetic QA Guest");
    await page.getByLabel(phone).fill("+16045550101");
    await page.getByRole("checkbox").check();
    await page.getByTestId("replacement-accept").click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByLabel(name)).toBeDisabled();
    await expect.poll(async () => (await context.cookies()).find(c => c.name === "qa-request")?.value).toMatch(/^[a-f0-9-]{36}$/);
    const request = (await context.cookies()).find(c => c.name === "qa-request")?.value;
    await page.getByTestId("replacement-accept").click();
    await expect(page.getByTestId("replacement-accepted")).toBeVisible();
    expect((await context.cookies()).find(c => c.name === "qa-request")?.value).toBe(request);
  });
  test(`${lang}: expired or card-required invitation cannot submit`, async ({ page, context }) => {
    for (const fault of ["expired", "card"]) {
      await context.addCookies([{ name: "qa-fault", value: fault, url: origin }]);
      await page.goto(`/?lang=${lang}`);
      await expect(page.getByTestId("replacement-accept")).toHaveCount(0);
    }
    expect((await context.cookies()).find(c => c.name === "qa-accept-count")).toBeUndefined();
  });
  test(`${lang}: sender creates only on click and recovers link after reload`, async ({ page, context }) => {
    await page.goto(`/?mode=sender&lang=${lang}`);
    const create = lang === "vi" ? "Tạo link nhờ người thay" : "Create replacement link";
    await expect(page.getByRole("button", { name: create })).toBeVisible();
    expect((await context.cookies()).find(c => c.name === "qa-start-count")).toBeUndefined();
    await page.getByRole("button", { name: create }).dblclick();
    const link = page.getByRole("textbox");
    await expect(link).toHaveValue(/\/booking\/replace\?token=a{64}/);
    expect((await context.cookies()).find(c => c.name === "qa-start-count")?.value).toBe("1");
    await page.reload();
    await expect(page.getByRole("heading", { name: lang === "vi" ? "Đang chờ người thay" : "Waiting for a replacement" })).toBeVisible();
    await page.getByRole("button", { name: lang === "vi" ? "Hiện lại link riêng đã tạo" : "Show the existing private link" }).click();
    await expect(page.getByRole("textbox")).toHaveValue(/\/booking\/replace\?token=a{64}/);
  });
  test(`${lang}: definitive contact rejection can be corrected`, async ({ page, context }) => {
    await context.addCookies([{ name: "qa-fault", value: "same-contact", url: origin }]);
    await page.goto(`/?lang=${lang}`);
    await page.getByLabel(name).fill("Synthetic QA Guest");
    await page.getByLabel(phone).fill("+16045550101");
    await page.getByRole("checkbox").check();
    await page.getByTestId("replacement-accept").click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByLabel(phone)).toBeEnabled();
    await page.getByLabel(phone).fill("+16045550102");
    await page.getByTestId("replacement-accept").click();
    await expect(page.getByTestId("replacement-accepted")).toBeVisible();
  });
  test(`${lang}: revoke then create uses fresh request after authoritative success`, async ({ page, context }) => {
    await page.goto(`/?mode=sender&lang=${lang}`);
    const create = lang === "vi" ? "Tạo link nhờ người thay" : "Create replacement link";
    await page.getByRole("button", { name: create }).click();
    await expect(page.getByRole("textbox")).toBeVisible();
    const first = (await context.cookies()).find(c => c.name === "qa-start-request")?.value;
    await page.getByRole("button", { name: lang === "vi" ? "Dừng nhờ người thay" : "Stop sharing this place" }).click();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await page.getByRole("button", { name: create }).click();
    await expect(page.getByRole("textbox")).toBeVisible();
    expect((await context.cookies()).find(c => c.name === "qa-start-request")?.value).not.toBe(first);
  });
  test(`${lang}: disabled feature has no sender UI or mutation`, async ({ page, context }) => {
    await context.addCookies([{ name: "qa-fault", value: "disabled", url: origin }]);
    await page.goto(`/?mode=sender&lang=${lang}`);
    await expect(page.getByTestId("group-replacement-options")).toHaveCount(0);
    expect((await context.cookies()).find(c => c.name === "qa-start-count")).toBeUndefined();
  });
  test(`${lang}: sender completed or blocked never offers a link`, async ({ page, context }) => {
    await context.addCookies([{ name: "qa-fault", value: "card", url: origin }]);
    await page.goto(`/?mode=sender&lang=${lang}`);
    await expect(page.getByTestId("group-replacement-options")).toBeVisible();
    await expect(page.getByRole("button", { name: lang === "vi" ? "Tạo link nhờ người thay" : "Create replacement link" })).toHaveCount(0);
    await context.addCookies([{ name: "qa-accepted", value: "1", url: origin }]);
    await page.reload();
    await expect(page.getByRole("heading", { name: lang === "vi" ? "Đã xác nhận người thay" : "Replacement confirmed" })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);
  });
}
