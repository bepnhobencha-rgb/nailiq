import { expect, test } from "@playwright/test";

// Exercise the actual panel/action transport, but NEVER forward an action POST.
// This verifies client recovery only; it cannot prove server/provider delivery.
for (const language of ["en", "vi"] as const) {
  for (const scenario of ["waiting", "failed", "unknown"] as const) {
    for (const failure of ["network", "http503"] as const) {
      test(`${language}: ${scenario} invitation recovers from ${failure} without duplicate or false success`, async ({ page, context }, testInfo) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await context.addInitScript((value) => {
          window.localStorage.setItem("nailiq-user-lang", value);
        }, language);
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let actionCount = 0;
        let otherMutationCount = 0;
        let externalCount = 0;
        await context.route("**/*", async (route) => {
          const request = route.request();
          if (new URL(request.url()).origin !== "http://127.0.0.1:3116") {
            externalCount++;
            return route.abort();
          }
          if (["GET", "HEAD"].includes(request.method())) return route.continue();
          if (request.method() !== "POST" || !request.headers()["next-action"]) {
            otherMutationCount++;
            return route.abort();
          }
          actionCount++;
          await gate;
          if (failure === "network") return route.abort("failed");
          return route.fulfill({ status: 503, contentType: "text/plain", body: "Synthetic service unavailable" });
        });

        try {
          await page.goto(`/?lang=${language}`, { waitUntil: "networkidle" });
          const button = page.getByTestId(`waitlist-invite-delivery-${scenario}`);
          const row = page.getByTestId(`waitlist-autonomy-delivery-${scenario}`);
          const originalRow = (await row.textContent()) ?? "";
          const originalDelivery = scenario === "waiting" ? null
            : await page.getByTestId(`waitlist-delivery-delivery-${scenario}`).textContent();
          // A real double-click and another row's click must not create a second
          // action while the first is unresolved. No DOM handlers are injected.
          await button.dblclick();
          await expect.poll(() => actionCount).toBe(1);
          await expect(button).toBeDisabled();
          await page.getByTestId("waitlist-invite-delivery-missing").click();
          expect(actionCount).toBe(1);
          await expect(row).toHaveText(originalRow);

          release();
          const toast = page.getByRole("status");
          await expect(toast).toBeVisible();
          await expect(toast).toBeInViewport({ ratio: 1 });
          await expect(button).toBeEnabled();
          await expect(row).toHaveText(originalRow);
          if (originalDelivery !== null) {
            await expect(page.getByTestId(`waitlist-delivery-delivery-${scenario}`)).toHaveText(originalDelivery);
          }
          // Server failure is surfaced as an error, never "delivered"/claimed.
          await expect(toast).toHaveClass(/border-nq-error/);
          const feedbackGeometry = await toast.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight,
              intersectsViewport: rect.top < window.innerHeight && rect.bottom > 0 };
          });
          await testInfo.attach("feedback-viewport-audit", {
            body: JSON.stringify(feedbackGeometry), contentType: "application/json",
          });
          await expect(row).not.toContainText(language === "vi" ? "Đã xác nhận giao" : "Delivery is confirmed");
          await button.click();
          await expect.poll(() => actionCount).toBe(2);
          await expect(button).toBeEnabled();
          await expect(row).toHaveText(originalRow);
          expect(otherMutationCount).toBe(0);
          expect(externalCount).toBe(0);
          expect(errors).toEqual([]);
          await testInfo.attach("retry-boundary", {
            body: JSON.stringify({ language, scenario, failure, actionCount, otherMutationCount, externalCount, forwardedActions: 0 }),
            contentType: "application/json",
          });
        } finally {
          release();
        }
      });
    }
  }
}
