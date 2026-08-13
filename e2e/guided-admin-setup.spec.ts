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
const LEGACY_SLUG = "e2e-guided-setup-disabled";
const SURFACES_SLUG = "e2e-guided-setup-surfaces";

let resumeOwner: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;
let completeOwner: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;
let legacyOwner: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;
let surfacesOwner: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;

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

    const legacySalon = await seedTestSalon({
      slug: LEGACY_SLUG,
      name: "Guided Setup Disabled Test Salon",
      phone: "15553334003",
    });
    legacyOwner = await seedTestSalonMember(legacySalon.salonId, "owner");

    const surfacesSalon = await seedTestSalon({
      slug: SURFACES_SLUG,
      name: "Guided Setup Surfaces Test Salon",
      phone: "15553334004",
      feature_flags: { guided_admin_setup_enabled: true },
    });
    await prepareTestSalonForGuidedSetup(surfacesSalon.salonId);
    surfacesOwner = await seedTestSalonMember(surfacesSalon.salonId, "owner");
  });

  test.afterAll(async () => {
    await cleanupTestSalon(RESUME_SLUG);
    await cleanupTestSalon(COMPLETE_SLUG);
    await cleanupTestSalon(LEGACY_SLUG);
    await cleanupTestSalon(SURFACES_SLUG);
    if (resumeOwner) await cleanupTestUser(resumeOwner.userId);
    if (completeOwner) await cleanupTestUser(completeOwner.userId);
    if (legacyOwner) await cleanupTestUser(legacyOwner.userId);
    if (surfacesOwner) await cleanupTestUser(surfacesOwner.userId);
  });

  test("saves real progress and resumes at the next required step after login", async ({
    page,
  }) => {
    if (!resumeOwner) throw new Error("resume owner fixture missing");

    await loginAs(page, resumeOwner);
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${RESUME_SLUG}/setup$`),
    );
    await expect(page.locator('[data-guided-setup-mode="true"]')).toBeVisible();
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
    await page
      .getByTestId("setup-timezone-select")
      .selectOption("America/Vancouver");
    await page.getByLabel(/salon phone/i).fill("+1 604 555 0198");
    await expect(saveButton).toBeEnabled();
    await saveButton.click();
    await expect(page.getByRole("button", { name: /saved/i })).toBeVisible();

    await expect(page.getByTestId("guided-setup-return-card")).toBeVisible();
    await page.getByTestId("guided-setup-continue").click();
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
    await expect(page.getByTestId("guided-setup-return-card")).toBeVisible();
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
    await expect(page).toHaveURL(new RegExp(`/dashboard/${COMPLETE_SLUG}/?$`));
    await expect(page.getByTestId("guided-admin-action-center")).toBeVisible();
    await expect(
      page.getByTestId("guided-action-open-front-desk"),
    ).toHaveAttribute("href", `/dashboard/${COMPLETE_SLUG}/center`);
  });

  test("keeps the original dashboard navigation when Guided Setup is disabled", async ({
    page,
  }) => {
    if (!legacyOwner) throw new Error("legacy owner fixture missing");

    await loginAs(page, legacyOwner);
    await page.goto(`/dashboard/${LEGACY_SLUG}/setup/address`);
    await expect(
      page.getByRole("link", { name: /dashboard/i }),
    ).toHaveAttribute("href", `/dashboard/${LEGACY_SLUG}`);
    await expect(page.getByTestId("guided-setup-return-card")).toHaveCount(0);

    await page.goto(`/dashboard/${LEGACY_SLUG}/settings`);
    await expect(page.getByTestId("guided-setup-return-card")).toHaveCount(0);
  });

  test("opens every setup destination and keeps payments and AI optional", async ({
    page,
  }) => {
    if (!surfacesOwner) throw new Error("surfaces owner fixture missing");

    await loginAs(page, surfacesOwner);
    await page.goto(`/dashboard/${SURFACES_SLUG}/setup`);

    const destinations = [
      ["salon-profile", `/dashboard/${SURFACES_SLUG}/setup/address`],
      ["business-hours", `/dashboard/${SURFACES_SLUG}/setup/hours`],
      ["team-access", `/dashboard/${SURFACES_SLUG}/setup/staff`],
      ["service-menu", `/dashboard/${SURFACES_SLUG}/setup/services`],
      ["booking-policies", `/dashboard/${SURFACES_SLUG}/no-show-protection`],
      [
        "communications",
        `/dashboard/${SURFACES_SLUG}/settings?section=notifications`,
      ],
      [
        "integrations",
        `/dashboard/${SURFACES_SLUG}/settings?section=integrations`,
      ],
      ["booking-preview", `/dashboard/${SURFACES_SLUG}/setup/preview`],
      ["go-live", `/dashboard/${SURFACES_SLUG}/settings/readiness`],
    ] as const;

    for (const [stepId, href] of destinations) {
      await expect(
        page.getByTestId(`guided-setup-step-${stepId}`),
      ).toHaveAttribute("href", href);
    }

    await expect(
      page.getByTestId("guided-setup-step-integrations"),
    ).toContainText(/Optional|Không bắt buộc/i);
    const progressBefore = await page
      .getByRole("progressbar")
      .getAttribute("aria-valuenow");

    await page.goto(`/dashboard/${SURFACES_SLUG}/setup/hours`);
    await page.getByTestId("hours-preset-standard").click();
    await page.getByTestId("hours-holiday-2026-12-25").click();
    await page.getByRole("button", { name: /Save all|Lưu tất cả/i }).click();
    await expect(page.getByText(/Hours saved|Đã lưu giờ/i)).toBeVisible();

    await page.goto(`/dashboard/${SURFACES_SLUG}/setup/staff`);
    await expect(page.locator('[data-testid^="staff-edit-"]').first()).toBeVisible();

    await page.goto(`/dashboard/${SURFACES_SLUG}/setup/services`);
    await expect(
      page.locator('[data-testid^="service-edit-"]').first(),
    ).toBeVisible();

    await page.goto(`/dashboard/${SURFACES_SLUG}/no-show-protection`);
    await expect(page.getByTestId("policy-en")).toHaveValue(
      "Please contact the salon before cancelling or rescheduling.",
    );
    await expect(page.getByTestId("policy-vi")).toHaveValue(
      "Vui lòng liên hệ salon trước khi huỷ hoặc đổi lịch.",
    );

    for (const [, href] of destinations.slice(0, 8)) {
      await page.goto(href);
      await expect(page.getByTestId("guided-setup-return-card")).toBeVisible();
    }

    await page.goto(`/dashboard/${SURFACES_SLUG}/setup/preview`);
    await expect(
      page.getByTestId("guided-open-public-booking"),
    ).toHaveAttribute("href", `/${SURFACES_SLUG}`);
    await expect(page.getByTestId("guided-preview-continue")).toHaveAttribute(
      "href",
      `/dashboard/${SURFACES_SLUG}/settings/readiness`,
    );

    await page.goto(`/dashboard/${SURFACES_SLUG}/setup`);
    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      progressBefore ?? "",
    );
  });
});
