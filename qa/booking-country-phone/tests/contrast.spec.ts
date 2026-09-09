import { expect, test, type Locator, type Page } from "@playwright/test";

async function paintedBackground(page: Page, control: Locator): Promise<number[]> {
  const png = await control.screenshot({ scale: "css" });
  return page.evaluate(async source => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    // Empty left padding, away from the border, label and arrow.
    return [...context.getImageData(8, Math.floor(image.height / 2), 1, 1).data].slice(0, 3);
  }, `data:image/png;base64,${png.toString("base64")}`);
}

function luminance(rgb: number[]): number {
  return rgb.map(value => value / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}

for (const width of [260, 320, 390, 1024]) {
  for (const mode of ["light", "dark"]) {
    for (const language of ["en", "vi"]) {
      test(`${width}px ${mode} ${language}: readable country selection and phone behavior`, async ({ page, context }, testInfo) => {
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await context.route("**/*", route => {
          const request = route.request();
          return new URL(request.url()).origin === "http://localhost:3115"
            && ["GET", "HEAD"].includes(request.method()) ? route.continue() : route.abort();
        });
        await page.setViewportSize({ width, height: 844 });
        await page.goto("/", { waitUntil: "networkidle" });
        const id = `${mode}-${language}`;
        const sample = page.getByRole("region", { name: id, exact: true });
        const select = sample.getByRole("combobox");
        const phone = sample.getByTestId(id);
        await expect(select).toHaveValue("CA");

        async function assertTheme() {
          const background = await paintedBackground(page, select);
          const phoneBackground = await paintedBackground(page, phone.locator(".."));
          const foreground = await select.evaluate(element => getComputedStyle(element).color);
          const text = foreground.match(/[\d.]+/g)!.slice(0, 3).map(Number);
          const a = luminance(text), b = luminance(background);
          expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
          expect(Math.max(...background.map((value, index) => Math.abs(value - phoneBackground[index])))).toBeLessThanOrEqual(3);
          expect(await select.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
          expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
        }

        await assertTheme();
        // The decorative arrow must remain visible without stealing the native
        // select's pointer target, including when its width expands.
        async function assertArrow() {
          const arrow = select.locator("..").locator("svg");
          await expect(arrow).toBeVisible();
          expect(await arrow.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.tagName;
          })).toBe("SELECT");
        }
        await assertArrow();
        await select.focus();
        await expect(select).toBeFocused();
        await expect.poll(() => select.evaluate(element => getComputedStyle(element).boxShadow)).not.toBe("none");
        await page.keyboard.press("Tab");
        await expect(phone).toBeFocused();
        await select.selectOption("__other__");
        await expect(select).toHaveValue("CA");
        await assertTheme();
        await assertArrow();
        await select.selectOption("VN");
        await phone.fill("912345678");
        await expect(sample.getByTestId(`${id}-value`)).toHaveText("+84912345678");
        await select.selectOption("__cluster__");
        await expect(select).toHaveValue("CA");
        await phone.fill("6045550123");
        await expect(sample.getByTestId(`${id}-value`)).toHaveText("+16045550123");
        await select.selectOption("US");
        await expect(sample.getByTestId(`${id}-value`)).toHaveText("+16045550123");
        const normalBorder = await select.evaluate(element => getComputedStyle(element).borderColor);
        await sample.getByTestId(`${id}-invalid`).check();
        await expect(phone).toHaveAttribute("aria-invalid", "true");
        await expect(phone).toHaveAttribute("aria-describedby", `${id}-error`);
        await expect.poll(() => select.evaluate(element => getComputedStyle(element).borderColor)).not.toBe(normalBorder);
        await assertTheme();
        await testInfo.attach("country-phone", { body: await sample.screenshot(), contentType: "image/png" });
        expect(errors).toEqual([]);
      });
    }
  }
}
