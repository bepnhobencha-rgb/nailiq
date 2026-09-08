/**
 * P0-2: the disconnect/stale banner must give a one-click Reload + show when
 * the board was last updated, so a receptionist never silently acts on stale
 * data. Uses an authenticated owner so a real channel is opened, blocks its
 * WebSocket, then verifies the banner and recovery through its Reload button.
 */
import { createHash } from "node:crypto";

import { test, expect, type Page } from "@playwright/test";

import {
  cleanupTestSalon,
  cleanupTestUser,
  seedTestSalonMember,
} from "../helpers/db";
import {
  cleanReceptionistData,
  gotoReceptionistCenter,
  rcSlug,
  seedReceptionistCenterFixture,
  type ReceptionistCenterFixture,
} from "./helpers";

let fx: ReceptionistCenterFixture;
let owner: Awaited<ReturnType<typeof seedTestSalonMember>>;

async function loginAsOwner(page: Page) {
  const digest = createHash("sha256").update(owner.email).digest("hex");
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `2001:db8::${digest.slice(0, 4)}:${digest.slice(4, 8)}`,
  });
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page.locator('input[inputmode="email"]').fill(owner.email);
  await page.locator('input[type="password"]').fill(owner.password);
  await page.getByTestId("password-signin-submit").click();
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });
}

test.beforeAll(async ({}, testInfo) => {
  fx = await seedReceptionistCenterFixture(rcSlug(testInfo.project.name));
  owner = await seedTestSalonMember(fx.salonId, "owner");
});
test.beforeEach(async () => {
  await cleanReceptionistData(fx.salonId);
});
test.afterAll(async ({}, testInfo) => {
  try {
    await cleanupTestSalon(rcSlug(testInfo.project.name));
  } finally {
    if (owner) await cleanupTestUser(owner.userId);
  }
});

test.describe("Connection banner — stale-data recovery UX", () => {
  for (const language of ["en", "vi"] as const) {
    test(`offline/reconnecting banner shows Reload + last-updated${language === "vi" ? " (Vietnamese)" : ""}`, async ({
      page,
      isMobile,
    }) => {
      const hydrationErrors: string[] = [];
      page.on("pageerror", (error) => {
        if (/#418|hydration/i.test(error.message))
          hydrationErrors.push(error.message);
      });
      await page
        .context()
        .addCookies([
          {
            name: "nailiq-user-lang",
            value: language,
            url: "http://localhost:3000",
          },
        ]);
      await page.addInitScript(
        (lang) => localStorage.setItem("nailiq-user-lang", lang),
        language,
      );
      await loginAsOwner(page);

      let allowReconnect = false;
      let blockedConnections = 0;
      let recoveredSubscriptions = 0;
      await page.routeWebSocket(/realtime\/v1\/websocket/, (ws) => {
        if (!allowReconnect) {
          blockedConnections += 1;
          void ws.close();
          return;
        }

        const server = ws.connectToServer();
        server.onMessage((message) => {
          const frame = message.toString();
          if (
            frame.includes(`receptionist-center-${fx.salonId}`) &&
            frame.includes('"phx_reply"') &&
            frame.includes('"status":"ok"')
          ) {
            recoveredSubscriptions += 1;
          }
          // Observe the real subscription reply without fabricating a response.
          ws.send(message);
        });
      });

      await gotoReceptionistCenter(page, fx.slug, {
        dateYmd: fx.ymdUtc,
        expectWalkinQueue: false,
        useDemoCookie: false,
      });
      expect(
        (await page.context().cookies()).map((cookie) => cookie.name),
      ).not.toContain("nailiq-demo-slug");
      await expect.poll(() => blockedConnections).toBeGreaterThan(0);

      const banner = page.locator(
        '[data-testid="connection-banner-offline"], [data-testid="connection-banner-reconnecting"]',
      );

      await expect(banner.first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("connection-reload")).toBeVisible();
      await expect(page.getByTestId("connection-last-updated")).toBeVisible();
      await expect(page.getByTestId("connection-last-updated")).toContainText(
        /Updated|Cập nhật/,
      );

      const viewports = isMobile
        ? [page.viewportSize()!, { width: 320, height: 568 }]
        : [page.viewportSize()!];
      for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        // Put Updated in the lower viewport where the old floating assistant
        // covered it. Center first so short screens can reach the same position.
        await page.getByTestId("connection-last-updated").evaluate((el) => {
          el.scrollIntoView({ block: "center" });
          const r = el.getBoundingClientRect();
          window.scrollBy(0, r.y + r.height / 2 - (window.innerHeight - 112));
        });
        await expect
          .poll(() =>
            page.getByTestId("connection-last-updated").evaluate((el) => {
              const r = el.getBoundingClientRect();
              const hit = document.elementFromPoint(
                r.x + r.width / 2,
                r.y + r.height / 2,
              );
              return !!hit && (hit === el || el.contains(hit));
            }),
          )
          .toBe(true);
      }

      // Keep the fault in place until the button actually requests a document
      // reload, then let the new page subscribe to the real local server.
      const reloadRequested = page
        .waitForRequest(
          (request) =>
            request.isNavigationRequest() &&
            request.frame() === page.mainFrame(),
        )
        .then(() => {
          allowReconnect = true;
        });
      await Promise.all([
        reloadRequested,
        page.waitForEvent("domcontentloaded"),
        page.getByTestId("connection-reload").click(),
      ]);
      await expect(
        page.getByTestId("receptionist-center-loaded"),
      ).toBeVisible();
      await expect
        .poll(() => recoveredSubscriptions, { timeout: 15_000 })
        .toBeGreaterThan(0);
      await expect(banner.first()).toBeHidden();

      // Opening the assistant remains available after recovery; do not submit
      // a prompt or trigger a provider call in this layout regression.
      const coco = page.getByRole("button", { name: /^(Ask Coco|Hỏi Coco)$/ });
      await coco.click();
      await expect(
        page.getByPlaceholder(/^(Type your question…|Nhập câu hỏi của bạn…)$/),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Close", exact: true })
        .last()
        .click();
      await expect(coco).toBeVisible();
      expect(hydrationErrors).toEqual([]);
    });
  }
});
