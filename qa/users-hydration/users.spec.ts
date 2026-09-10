import { expect, test } from "@playwright/test";

for (const timezoneId of ["America/Los_Angeles", "Asia/Tokyo"]) {
  test.describe(timezoneId, () => {
    test.use({ timezoneId });
    for (const skewMs of [90_000, -90_000, 86_400_000]) {
      test(`SSR and hydration agree with clock skew ${skewMs}`, async ({ page }) => {
        const errors: string[] = [];
        const blocked: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("console", message => {
          if (message.type() === "error") errors.push(message.text());
        });
        await page.route("**/*", route => {
          const request = route.request();
          if (new URL(request.url()).origin !== "http://127.0.0.1:3122" || request.method() !== "GET") {
            blocked.push(request.method() + " " + new URL(request.url()).origin);
            return route.abort();
          }
          return route.continue();
        });
        await page.clock.setFixedTime(new Date(Date.now() + skewMs));
        const response = await page.goto("/");
        expect(response?.status()).toBe(200);
        const html = await response!.text();
        // Compare actual SSR table cells with the hydrated DOM; no reconstructed formatter.
        const ssrCells = Array.from(html.matchAll(/<td[^>]*>([^<]+)<\/td>/g), match => match[1]);
        expect(ssrCells).toHaveLength(12);
        // Sorting/filtering proves React handlers are attached, even if hydration recovered.
        await page.getByRole("button", { name: "Email", exact: true }).click();
        const search = page.getByRole("searchbox");
        await search.fill("minute@");
        await expect(page.getByText("1 of 6 users")).toBeVisible();
        await expect(page.locator("tbody tr")).toHaveCount(1);
        await search.clear();
        await page.getByRole("button", { name: "Last active", exact: true }).click();
        await expect(page.getByText("6 of 6 users")).toBeVisible();
        const cells = await page.locator("tbody tr").evaluateAll(rows => rows.flatMap(row =>
          Array.from(row.querySelectorAll("td")).slice(-2).map(td => td.textContent),
        ));
        expect(cells).toEqual(ssrCells);
        await expect(page.locator("tbody tr").filter({ hasText: "live@example.invalid" })).toContainText("Live");
        await expect(page.locator("tbody tr").filter({ hasText: "today@example.invalid" })).toContainText("Today");
        await expect(page.locator("tbody tr").filter({ hasText: "week@example.invalid" })).toContainText("This week");
        expect(errors).toEqual([]);
        expect(blocked).toEqual([]);
        if (skewMs === 90_000) await page.screenshot({ path: test.info().outputPath("users.png"), fullPage: true });
      });
    }
  });
}
