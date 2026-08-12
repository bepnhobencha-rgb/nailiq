import { expect, test, type Page } from "@playwright/test";
import {
  cleanupTestSalon,
  cleanupTestUser,
  prepareTestSalonForGuidedSetup,
  seedTestSalon,
  seedTestSalonMember,
} from "./helpers/db";

const RESUME_SLUG = "e2e-guided-setup-resume";
const COMPLETE_SLUG = "e2e-guided-setup-complete";

let resumeOwner:
  | Awaited<ReturnType<typeof seedTestSalonMember>>
  | undefined;
let completeOwner:
  | Awaited<ReturnType<typeof seedTestSalonMember>>
  | undefined;

async function loginAs(
  page: Page,
  account: { email: string; password: string },
) {
  await page.goto("/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page.locator('input[inputmode="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL(/\/dashboard\//, { timeout: 30_000 });
}

async function recordGoLiveAttestations(page: Page) {
  const steps = [
    ["hours_confirmed", "Owner confirmed the saved business hours."],
    ["otp_policy_confirmed", "Owner confirmed the consent policy."],
    ["live_rehearsal_completed", "Owner completed the approved rehearsal."],
    ["owner_approved", "Owner approved this exact setup for go-live."],
  ] as const;

  for (const [key, note] of steps) {
    await page.getByTestId(`go-live-note-${key}`).fill(note);
    await page.getByTestId(`go-live-submit-${key}`).click();
    await expect(page.getByTestId(`go-live-attestation-${key}`)).toContainText(
      /Đang hiệu lực|Active/i,
    );
  }
}

test.describe("Guided Admin Setup", () => {
  test.beforeAll(async () => {
    const resumeSalon = await seedTestSalon({
      slug: RESUME_SLUG,
      name: "Guided Resume Test Salon",
      phone: "15553334001",
      feature_flags: { guided_admin_setup_enabled: true },
    });
    resumeOwner = await seedTestSalonMember(resumeSalon.salonId, "owner");

    const completeSalon = await seedTestSalon({
      slug: COMPLETE_SLUG,
      name: "Guided Complete Test Salon",
      phone: "15553334002",
      feature_flags: { guided_admin_setup_enabled: true },
    });
    await prepareTestSalonForGuidedSetup(completeSalon.salonId);
    completeOwner = await seedTestSalonMember(completeSalon.salonId, "owner");
  });

  test.afterAll(async () => {
    await cleanupTestSalon(RESUME_SLUG);
    await cleanupTestSalon(COMPLETE_SLUG);
    if (resumeOwner) await cleanupTestUser(resumeOwner.userId);
    if (completeOwner) await cleanupTestUser(completeOwner.userId);
  });

  test("saves real progress and resumes at the next required step after login", async ({
    page,
  }) => {
    if (!resumeOwner) throw new Error("resume owner fixture missing");

    await loginAs(page, resumeOwner);
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${RESUME_SLUG}/setup$`),
    );
    await expect(page.getByTestId("guided-setup-next")).toBeVisible();
    await expect(
      page.getByTestId("guided-setup-step-salon-profile"),
    ).toBeVisible();
    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "25",
    );

    await page.getByTestId("guided-setup-next").click();
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${RESUME_SLUG}/setup/address$`),
    );
    await expect(page.getByRole("link", { name: /setup/i })).toBeVisible();

    const saveButton = page.getByRole("button", { name: /^save$/i });
    await expect(saveButton).toBeDisabled();
    await page.getByLabel(/street address/i).fill("123 QA Main Street");
    await page.getByLabel(/^city/i).fill("Vancouver");
    await page.getByLabel(/province|state/i).fill("BC");
    await page.getByLabel(/postal|zip/i).fill("V6B 1A1");
    await page.getByTestId("setup-timezone-select").selectOption(
      "America/Vancouver",
    );
    await page.getByLabel(/salon phone/i).fill("+1 604 555 0198");
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(page.getByRole("button", { name: /saved/i })).toBeVisible();

    await page.getByRole("link", { name: /setup/i }).click();
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${RESUME_SLUG}/setup$`),
    );
    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "38",
    );
    await expect(page.getByTestId("guided-setup-next")).toContainText(
      /Business hours|Giờ mở cửa/i,
    );

    await page.context().clearCookies();
    await loginAs(page, resumeOwner);
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${RESUME_SLUG}/setup$`),
    );
    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "38",
    );
    await expect(page.getByTestId("guided-setup-next")).toContainText(
      /Business hours|Giờ mở cửa/i,
    );
  });

  test("opens the dashboard only after the owner approves the current readiness snapshot", async ({
    page,
  }) => {
    if (!completeOwner) throw new Error("complete owner fixture missing");

    await loginAs(page, completeOwner);
    await page.goto(`/dashboard/${COMPLETE_SLUG}/settings/readiness`);
    await expect(page.getByTestId("go-live-readiness-summary")).toContainText(
      /5\/5/,
    );
    await recordGoLiveAttestations(page);

    await page.goto(`/dashboard/${COMPLETE_SLUG}/setup`);
    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    await expect(
      page.getByRole("heading", { name: /Setup complete|Thiết lập hoàn tất/i }),
    ).toBeVisible();

    await page.goto(`/dashboard/${COMPLETE_SLUG}`);
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${COMPLETE_SLUG}/?$`),
    );
    await expect(page.getByTestId("guided-setup-next")).toHaveCount(0);
  });
});
