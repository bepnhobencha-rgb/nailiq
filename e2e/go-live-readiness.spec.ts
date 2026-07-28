import { expect, test, type Page } from "@playwright/test";
import { cleanupTestSalon, seedTestSalon } from "./helpers/db";

const SLUG = "e2e-go-live-readiness";
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

async function authAsDemoOwner(page: Page) {
  await page.context().addCookies([
    { name: "nailiq-demo-slug", value: SLUG, url: BASE },
  ]);
}

test.describe("Go-live readiness", () => {
  test.beforeAll(async () => {
    await seedTestSalon({
      slug: SLUG,
      name: "Readiness Test Salon",
      phone: "15553332001",
      salon_phone: "+15553332002",
      phone_otp_enabled: true,
    });
  });

  test.afterAll(async () => {
    await cleanupTestSalon(SLUG);
  });

  test("owner can open truthful readiness checks from Settings", async ({
    page,
  }) => {
    await authAsDemoOwner(page);
    await page.goto(`/dashboard/${SLUG}/settings`);

    const readinessLink = page.getByRole("link", {
      name: "Kiểm tra sẵn sàng go-live",
    });
    await expect(readinessLink).toBeVisible();
    await readinessLink.click();

    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${SLUG}/settings/readiness`),
    );
    await expect(page.getByTestId("go-live-readiness-summary")).toBeVisible();
    await expect(page.getByTestId("readiness-check-catalog")).toContainText(
      /1 dịch vụ đang hoạt động|1 active service/i,
    );
    await expect(page.getByTestId("readiness-check-staff")).toContainText(
      /1 nhân viên đang hoạt động|1 active staff member/i,
    );

    // The seeded salon deliberately has no address. The screen must fail
    // closed instead of trusting profile_complete alone.
    await expect(page.getByTestId("readiness-check-identity")).toContainText(
      /Cần sửa|Action/i,
    );
    await expect(
      page.getByTestId("readiness-check-human-approval"),
    ).toContainText(/Cần xác nhận|Review/i);
    await expect(page.getByText("Chưa sẵn sàng go-live")).toBeVisible();
  });
});
