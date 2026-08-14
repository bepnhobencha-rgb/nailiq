import { expect, test, type Page } from "@playwright/test";
import {
  cleanupTestSalon,
  cleanupTestUser,
  getRegisteredSalonForUser,
  prepareTestSalonForGuidedSetup,
  seedTestSalon,
  seedTestSalonMember,
  seedTestUser,
  setTestSalonFeatureFlags,
} from "./helpers/db";
import { createServiceRoleClient } from "../src/shared/lib/supabase/serviceRole";

const RESUME_SLUG = "e2e-guided-setup-resume";
const COMPLETE_SLUG = "e2e-guided-setup-complete";
const LEGACY_SLUG = "e2e-guided-setup-disabled";
const SURFACES_SLUG = "e2e-guided-setup-surfaces";

let resumeOwner: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;
let completeOwner: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;
let legacyOwner: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;
let surfacesAdmin: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;

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
    // `seedTestSalon` intentionally creates a broadly usable fixture for the
    // rest of the suite. Guided Setup needs a genuinely incomplete starting
    // point so its percentage is certified from saved readiness data instead
    // of button clicks. Staff + service are the only initial PASS steps (2/8).
    const resumeDb = createServiceRoleClient();
    const { error: resumeResetError } = await resumeDb
      .from("salons")
      .update({ profile_complete: false, opening_hours: null } as never)
      .eq("id", resumeSalon.salonId);
    if (resumeResetError) {
      throw new Error(`guided resume fixture reset: ${resumeResetError.message}`);
    }
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
    surfacesAdmin = await seedTestSalonMember(surfacesSalon.salonId, "admin");
  });

  test.afterAll(async () => {
    await cleanupTestSalon(RESUME_SLUG);
    await cleanupTestSalon(COMPLETE_SLUG);
    await cleanupTestSalon(LEGACY_SLUG);
    await cleanupTestSalon(SURFACES_SLUG);
    if (resumeOwner) await cleanupTestUser(resumeOwner.userId);
    if (completeOwner) await cleanupTestUser(completeOwner.userId);
    if (legacyOwner) await cleanupTestUser(legacyOwner.userId);
    if (surfacesAdmin) await cleanupTestUser(surfacesAdmin.userId);
  });

  test("a newly registered trial owner enters one next step and resumes there after sign-in", async ({
    page,
  }) => {
    const owner = await seedTestUser();
    const salonName = `E2E Guided Registration ${owner.userId.slice(0, 8)}`;

    try {
      await page.goto("/register");
      await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
        "data-hydrated",
        "true",
      );
      await page.locator('input[inputmode="email"]').fill(owner.email);
      await page.locator('input[type="password"]').fill(owner.password);
      await page.getByRole("button", { name: /^sign in$/i }).click();
      await expect(page).toHaveURL(/\/register\/setup(?:\?|$)/, {
        timeout: 15_000,
      });

      await page.locator("#register-setup-salon-name").fill(salonName);
      await page
        .getByRole("button", {
          name: /create your booking page|tạo trang đặt lịch/i,
        })
        .click();
      await expect(page).toHaveURL(/\/register\/success\?/, {
        timeout: 30_000,
      });

      const registration = await getRegisteredSalonForUser(owner.userId);
      const trialStart = Date.parse(registration.salon.trial_started_at ?? "");
      const trialEnd = Date.parse(registration.salon.trial_ends_at ?? "");
      expect(registration.salon.subscription_status).toBe("trialing");
      expect(trialEnd - trialStart).toBe(14 * 24 * 60 * 60 * 1_000);
      expect(registration.salon.stripe_customer_id).toBeNull();
      expect(registration.salon.stripe_subscription_id).toBeNull();
      expect(registration.salon.payment_provider).toBeNull();

      // Emulate the audited SuperAdmin pilot toggle only after this throwaway
      // salon exists. The feature remains default-OFF for every real salon.
      await setTestSalonFeatureFlags(registration.salon.id, {
        guided_admin_setup_enabled: true,
      });

      await page
        .getByRole("button", {
          name: /go to dashboard|vào bảng điều khiển/i,
        })
        .click();
      await expect(page).toHaveURL(
        new RegExp(`/dashboard/${registration.salon.slug}/setup$`),
        { timeout: 30_000 },
      );
      await expect(
        page.locator('[data-guided-setup-mode="true"]'),
      ).toBeVisible();
      await expect(page.getByTestId("guided-setup-next-title")).toContainText(
        /Salon information|Thông tin salon/i,
      );
      const progressBefore = await page
        .getByRole("progressbar")
        .getAttribute("aria-valuenow");

      await page.context().clearCookies();
      await loginAs(page, owner);
      await expect(page).toHaveURL(
        new RegExp(`/dashboard/${registration.salon.slug}/setup$`),
      );
      await expect(page.getByTestId("guided-setup-next-title")).toContainText(
        /Salon information|Thông tin salon/i,
      );
      await expect(page.getByRole("progressbar")).toHaveAttribute(
        "aria-valuenow",
        progressBefore ?? "",
      );
    } finally {
      await cleanupTestUser(owner.userId);
    }
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
    await expect(page.getByTestId("guided-autosave-message")).toBeVisible();

    const saveButton = page.getByRole("button", { name: /^save$/i });
    await expect(saveButton).toBeDisabled();
    await page.getByLabel(/street address/i).fill("123 QA Main Street");
    await page.getByLabel(/^city/i).fill("Vancouver");
    await page
      .getByRole("textbox", { name: /^province\/state$/i })
      .fill("BC");
    await page.getByLabel(/postal|zip/i).fill("V6B 1A1");
    await page
      .getByTestId("setup-timezone-select")
      .selectOption("America/Vancouver");
    await page.getByLabel(/salon phone/i).fill("+1 604 555 0198");
    await expect(saveButton).toBeEnabled();
    await expect(page.getByRole("button", { name: /saved/i })).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByTestId("guided-setup-return-card")).toBeVisible();
    await page.getByTestId("guided-setup-continue").click();
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${RESUME_SLUG}/setup$`),
    );
    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    await expect(page.getByTestId("guided-setup-next-title")).toContainText(
      /Business hours|Giờ mở cửa/i,
    );

    await page.getByTestId("guided-setup-next").click();
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${RESUME_SLUG}/setup/hours$`),
    );
    await expect(page.getByTestId("guided-autosave-message")).toBeVisible();
    await page.getByTestId("hours-preset-standard").click();
    await expect(page.getByRole("button", { name: /saved/i })).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("guided-setup-continue").click();
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${RESUME_SLUG}/setup$`),
    );
    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "63",
    );
    await expect(page.getByTestId("guided-setup-next-title")).toContainText(
      /Booking and cancellation rules|Quy định đặt và huỷ lịch/i,
    );

    await page.context().clearCookies();
    await loginAs(page, resumeOwner);
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${RESUME_SLUG}/setup$`),
    );
    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "63",
    );
    await expect(page.getByTestId("guided-setup-next-title")).toContainText(
      /Booking and cancellation rules|Quy định đặt và huỷ lịch/i,
    );
  });

  test("opens the dashboard only after the owner approves the current readiness snapshot", async ({
    page,
  }) => {
    if (!completeOwner) throw new Error("complete owner fixture missing");

    await loginAs(page, completeOwner);
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${COMPLETE_SLUG}/setup$`),
      { timeout: 30_000 },
    );
    await expect(page.locator('[data-guided-setup-mode="true"]')).toBeVisible();
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
      page.locator(
        `header a[href="/dashboard/${LEGACY_SLUG}"]`,
      ),
    ).toHaveAttribute("href", `/dashboard/${LEGACY_SLUG}`);
    await expect(page.getByTestId("guided-setup-return-card")).toHaveCount(0);
    await expect(page.getByTestId("guided-autosave-message")).toHaveCount(0);

    await page.goto(`/dashboard/${LEGACY_SLUG}/settings`);
    await expect(page.getByTestId("guided-setup-return-card")).toHaveCount(0);
  });

  test("opens every setup destination and keeps payments and AI optional", async ({
    page,
  }) => {
    if (!surfacesAdmin) throw new Error("surfaces admin fixture missing");

    await loginAs(page, surfacesAdmin);
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${SURFACES_SLUG}/setup$`),
      { timeout: 30_000 },
    );
    await expect(page.locator('[data-guided-setup-mode="true"]')).toBeVisible();

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
    await expect(page.getByText("Jenny", { exact: true })).toBeVisible();
    await expect(page.getByText(/Nail tech|Thợ nail|Thợ phụ/i)).toBeVisible();
    await expect(
      page.locator('[data-testid^="staff-edit-"]').first(),
    ).toBeVisible();
    await page.locator('[data-testid^="staff-edit-"]').first().click();
    await page.getByTestId("staff-drawer-name").fill("Jenny QA");
    await page
      .getByRole("button", { name: /^(save|lưu)$/i })
      .last()
      .click();
    await expect(page.getByText("Jenny QA", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("Jenny QA", { exact: true })).toBeVisible();

    await page.goto(`/dashboard/${SURFACES_SLUG}/setup/services`);
    await expect(page.getByText("Gel Manicure", { exact: true })).toBeVisible();
    await expect(page.getByText(/\$45(?:\.00)?/).first()).toBeVisible();
    await expect(
      page.locator('[data-testid^="service-edit-"]').first(),
    ).toBeVisible();
    await page.locator('[data-testid^="service-edit-"]').first().click();
    await expect(page.getByTestId("service-drawer-duration")).toHaveValue(
      "45",
    );
    await page.getByTestId("service-drawer-price").fill("46");
    await page
      .getByRole("button", { name: /^(save|lưu)$/i })
      .last()
      .click();
    await expect(page.getByText(/\$46(?:\.00)?/).first()).toBeVisible();
    // Reload once, then let slower mobile WebKit finish rendering. Repeatedly
    // reloading inside expect.poll starves the page before the persisted row
    // can render, even though the server action has already completed.
    await page.reload();
    await expect(page.getByText(/\$46(?:\.00)?/).first()).toBeVisible({
      timeout: 15_000,
    });

    await page.goto(`/dashboard/${SURFACES_SLUG}/no-show-protection`);
    await expect(page.getByTestId("policy-en")).toHaveValue(
      "Please contact the salon before cancelling or rescheduling.",
    );
    await expect(page.getByTestId("policy-vi")).toHaveValue(
      "Vui lòng liên hệ salon trước khi huỷ hoặc đổi lịch.",
    );
    await expect(page.getByTestId("booking-policy-coverage")).toBeVisible();
    await expect(page.getByTestId("booking-policy-group-status")).toContainText(
      /optional|không bắt buộc/i,
    );
    await expect(
      page.getByTestId("booking-policy-after-hours-status"),
    ).toContainText(/Owner\/Admin|Owner|Admin/i);
    // This fixture is an Admin. It can review and configure salon policy. The
    // whole-party control is conditional on no-show protection being enabled;
    // the late-cancellation window remains visible for policy review.
    await expect(page.getByTestId("noshow-whole-party-toggle")).toHaveCount(0);
    await expect(page.getByTestId("self-cancel-fee-toggle")).toBeVisible();
    await expect(page.getByTestId("self-cancel-window-hours")).toBeVisible();

    await page.goto(
      `/dashboard/${SURFACES_SLUG}/settings?section=notifications`,
    );
    await expect(
      page.getByTestId("settings-email-verified-badge"),
    ).toBeVisible();
    await expect(page.getByTestId("customer-channel-card")).toBeVisible();
    await expect(page.getByTestId("staff-notifications-card")).toBeVisible();
    await expect(page.getByTestId("staff-notif-locale-vi")).toBeChecked();

    const notificationCard = page.getByTestId("staff-notifications-card");
    await notificationCard.getByTestId("staff-notif-locale-en").check();
    await notificationCard.getByRole("button").click();
    await expect(
      notificationCard.getByTestId("staff-notif-toast"),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("staff-notif-locale-en")).toBeChecked();

    await page.getByTestId("staff-notif-locale-vi").check();
    await page
      .getByTestId("staff-notifications-card")
      .getByRole("button")
      .click();
    await expect(page.getByTestId("staff-notif-toast")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("staff-notif-locale-vi")).toBeChecked();

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
