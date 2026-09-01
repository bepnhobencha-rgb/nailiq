import { createHash } from "node:crypto";

import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  cleanupTestSalon,
  cleanupTestUser,
  configureTestGuidedAdminSetup,
  getRegisteredSalonForUser,
  prepareTestSalonForGuidedSetup,
  seedTestSalon,
  seedTestSalonMember,
  seedTestUser,
} from "./helpers/db";
import { createServiceRoleClient } from "../src/shared/lib/supabase/serviceRole";

const RESUME_SLUG = "e2e-guided-setup-resume";
const COMPLETE_SLUG = "e2e-guided-setup-complete";
const LEGACY_SLUG = "e2e-guided-setup-disabled";
const SURFACES_SLUG = "e2e-guided-setup-surfaces";

let resumeOwner: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;
let completeOwner: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;
let completeReceptionist:
  | Awaited<ReturnType<typeof seedTestSalonMember>>
  | undefined;
let completeSalonId: string | undefined;
let resumeSalonId: string | undefined;
let surfacesSalonId: string | undefined;
let activeGuidedSalonId: string | undefined;
let legacyOwner: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;
let surfacesAdmin: Awaited<ReturnType<typeof seedTestSalonMember>> | undefined;

async function isolateAuthRateLimitBucket(page: Page, email: string) {
  const digest = createHash("sha256").update(email).digest("hex");
  await page.setExtraHTTPHeaders({
    "x-forwarded-for": `2001:db8::${digest.slice(0, 4)}:${digest.slice(4, 8)}`,
  });
}

async function loginAs(
  page: Page,
  account: { email: string; password: string },
) {
  await isolateAuthRateLimitBucket(page, account.email);
  await gotoAfterSignIn(page, "/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page.locator('input[inputmode="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  await page
    .getByRole("button", { name: /^sign in$/i })
    .click({ noWaitAfter: true });
  await expect(page).toHaveURL(/\/dashboard\//, { timeout: 30_000 });
}

async function signInForDirectRoute(
  page: Page,
  account: { email: string; password: string },
) {
  await isolateAuthRateLimitBucket(page, account.email);
  await gotoAfterSignIn(page, "/register");
  await expect(page.getByTestId("social-auth-controls")).toHaveAttribute(
    "data-hydrated",
    "true",
  );
  await page.locator('input[inputmode="email"]').fill(account.email);
  await page.locator('input[type="password"]').fill(account.password);
  await page
    .getByRole("button", { name: /^sign in$/i })
    .click({ noWaitAfter: true });
  await expect(page).toHaveURL(/\/(?:dashboard\/|register\/setup)/, {
    timeout: 30_000,
  });
}

async function gotoAfterSignIn(page: Page, path: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(path, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        (!error.message.includes("ERR_ABORTED") &&
          !error.message.includes("interrupted by another navigation"))
      ) {
        throw error;
      }
    }
  }
  await page.goto(path, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
}

async function clearAppSessionCookies(page: Page) {
  // Protected Vercel Previews use `_vercel_jwt` to prove the one-time
  // Automation Bypass handshake. Clearing every cookie logs the synthetic
  // salon user out but also throws the browser back to Vercel SSO, so the next
  // `/register` navigation never reaches NailIQ. Preserve only that
  // infrastructure cookie; local/CI contexts do not have it and still clear
  // every application cookie exactly as before.
  await page.context().clearCookies({ name: /^(?!_vercel_jwt$).*$/ });
}

async function proveControlledSearchHydrated(
  searchbox: Locator,
  filteredItems: Locator,
) {
  // The setup lists are server-rendered, so a row and its edit button can be
  // visible before React has attached their handlers on a remote Preview. A
  // controlled search proves client hydration without relying on a sleep.
  await expect(async () => {
    await searchbox.fill("");
    await searchbox.fill("__guided_hydration_probe__");
    await expect(filteredItems).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await searchbox.fill("");
}

async function recordSafeGuidedAttestations(page: Page) {
  const steps = [
    ["hours_confirmed", "Owner confirmed the saved business hours."],
    ["otp_policy_confirmed", "Owner confirmed the consent policy."],
    [
      "owner_approved",
      "Owner approved the exact reviewed configuration snapshot.",
    ],
  ] as const;

  // The readiness cards are server-rendered, so WebKit can see and click the
  // first button before React has attached its handler on a remote Preview.
  // Prove hydration with the client-only short-note validation: it returns
  // before the server action and therefore cannot append an audit event.
  await expect(async () => {
    await page.getByTestId("go-live-note-hours_confirmed").fill("");
    await page.getByTestId("go-live-submit-hours_confirmed").click();
    await expect(page.getByTestId("go-live-attestation-message")).toContainText(
      /at least 10 characters|ít nhất 10 ký tự/i,
      { timeout: 1_000 },
    );
  }).toPass({ timeout: 15_000 });

  for (const [key, note] of steps) {
    const noteField = page.getByTestId(`go-live-note-${key}`);
    await noteField.fill(note);
    await page.getByTestId(`go-live-submit-${key}`).click();
    // A successful server action clears only the submitted note. Waiting for
    // that state prevents a prior step's status message from becoming a false
    // positive and avoids ever retrying a real attest/revoke click.
    await expect(noteField).toHaveValue("", { timeout: 30_000 });
    await expect(page.getByTestId("go-live-attestation-message")).toContainText(
      /Recorded in the audit history|This state was already recorded|Đã ghi vào lịch sử audit|Trạng thái này đã được ghi nhận trước đó/i,
      { timeout: 30_000 },
    );
    await expect(page.getByTestId(`go-live-attestation-${key}`)).toContainText(
      /Đang hiệu lực|Active/i,
      { timeout: 30_000 },
    );
  }
}

async function guidedPreviewSideEffectSnapshot(salonId: string) {
  const client = createServiceRoleClient();
  const tables = [
    "bookings",
    "booking_waitlist_entries",
    "booking_notifications",
    "booking_events",
    "scheduled_notifications",
    "ai_actions_log",
    "ai_policy_decisions",
    "ai_upsell_log",
    "voice_ai_sessions",
    "payment_disputes",
    "salon_go_live_attestations",
    "owner_notification_log",
  ] as const;
  const pairs = await Promise.all(
    tables.map(async (table) => {
      const { count, error } = await client
        .from(table)
        .select("*", { count: "exact", head: true })
        .eq("salon_id", salonId);
      if (error || typeof count !== "number") {
        throw new Error(
          `guided preview snapshot ${table}: ${error?.message ?? "missing count"}`,
        );
      }
      return [table, count] as const;
    }),
  );
  return Object.fromEntries(pairs);
}

test.describe("Guided Admin Setup", () => {
  test.beforeAll(async () => {
    const resumeSalon = await seedTestSalon({
      slug: RESUME_SLUG,
      name: "Guided Resume Test Salon",
      phone: "15553334001",
    });
    resumeSalonId = resumeSalon.salonId;
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
    });
    completeSalonId = completeSalon.salonId;
    await prepareTestSalonForGuidedSetup(completeSalon.salonId);
    completeOwner = await seedTestSalonMember(completeSalon.salonId, "owner");
    completeReceptionist = await seedTestSalonMember(
      completeSalon.salonId,
      "receptionist",
    );

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
    });
    surfacesSalonId = surfacesSalon.salonId;
    await prepareTestSalonForGuidedSetup(surfacesSalon.salonId);
    surfacesAdmin = await seedTestSalonMember(surfacesSalon.salonId, "admin");
  });

  test.afterEach(async () => {
    if (activeGuidedSalonId) {
      await configureTestGuidedAdminSetup(activeGuidedSalonId, false);
      activeGuidedSalonId = undefined;
    }
  });

  test.afterAll(async () => {
    await cleanupTestSalon(RESUME_SLUG);
    await cleanupTestSalon(COMPLETE_SLUG);
    await cleanupTestSalon(LEGACY_SLUG);
    await cleanupTestSalon(SURFACES_SLUG);
    if (resumeOwner) await cleanupTestUser(resumeOwner.userId);
    if (completeOwner) await cleanupTestUser(completeOwner.userId);
    if (completeReceptionist) {
      await cleanupTestUser(completeReceptionist.userId);
    }
    if (legacyOwner) await cleanupTestUser(legacyOwner.userId);
    if (surfacesAdmin) await cleanupTestUser(surfacesAdmin.userId);
  });

  test("a newly registered trial owner enters one next step and resumes there after sign-in", async ({
    page,
  }) => {
    const owner = await seedTestUser();
    const salonName = `E2E Guided Registration ${owner.userId.slice(0, 8)}`;

    try {
      await isolateAuthRateLimitBucket(page, owner.email);
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

      // The auth redirect can update the URL before the App Router finishes
      // committing the setup page. Wait for that navigation to settle so a
      // late RSC commit cannot replace the controlled input after `fill()`.
      await page.waitForLoadState("networkidle");
      const salonNameInput = page.locator("#register-setup-salon-name");
      await salonNameInput.fill(salonName);
      await expect(salonNameInput).toHaveValue(salonName);
      const createBookingPage = page.getByRole("button", {
        name: /create your booking page|tạo trang đặt lịch/i,
      });
      await expect(createBookingPage).toBeEnabled();
      await createBookingPage.click();
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
      await configureTestGuidedAdminSetup(registration.salon.id, true);
      activeGuidedSalonId = registration.salon.id;

      await page
        .getByRole("button", {
          name: /start coco setup|bắt đầu coco setup|go to dashboard|vào bảng điều khiển/i,
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
        .getByRole("progressbar", {
          name: /setup progress|tiến độ thiết lập/i,
        })
        .getAttribute("aria-valuenow");

      await clearAppSessionCookies(page);
      await loginAs(page, owner);
      await expect(page).toHaveURL(
        new RegExp(`/dashboard/${registration.salon.slug}/setup$`),
      );
      await expect(page.getByTestId("guided-setup-next-title")).toContainText(
        /Salon information|Thông tin salon/i,
      );
      await expect(
        page.getByRole("progressbar", {
          name: /setup progress|tiến độ thiết lập/i,
        }),
      ).toHaveAttribute("aria-valuenow", progressBefore ?? "");
    } finally {
      await cleanupTestUser(owner.userId);
    }
  });

  test("saves real progress and resumes at the next required step after login", async ({
    page,
  }) => {
    if (!resumeOwner) throw new Error("resume owner fixture missing");
    if (!resumeSalonId) throw new Error("resume salon fixture missing");
    await configureTestGuidedAdminSetup(resumeSalonId, true);
    activeGuidedSalonId = resumeSalonId;

    await signInForDirectRoute(page, resumeOwner);
    await gotoAfterSignIn(page, `/dashboard/${RESUME_SLUG}/setup`);
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${RESUME_SLUG}/setup$`),
    );
    await expect(page.locator('[data-guided-setup-mode="true"]')).toBeVisible();
    await expect(page.getByTestId("guided-setup-next")).toBeVisible();
    await expect(
      page.getByTestId("guided-setup-step-salon-profile"),
    ).toBeVisible();
    await expect(
      page.getByRole("progressbar", {
        name: /setup progress|tiến độ thiết lập/i,
      }),
    ).toHaveAttribute("aria-valuenow", "25");

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

    // The Saved state is only truthful after updateAddress has recomputed and
    // persisted the public-booking gate from the saved address + active
    // service/staff rows. Assert the database state separately from the hub
    // percentage so a refresh failure cannot hide behind optimistic UI.
    await expect
      .poll(async () => {
        const { data, error } = await createServiceRoleClient()
          .from("salons")
          .select("address, profile_complete")
          .eq("slug", RESUME_SLUG)
          .single();
        if (error) throw error;
        return data;
      })
      .toMatchObject({
        address: expect.stringContaining("123 QA Main Street"),
        profile_complete: true,
      });

    await expect(page.getByTestId("guided-setup-return-card")).toBeVisible();
    await page.getByTestId("guided-setup-continue").click();
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${RESUME_SLUG}/setup$`),
    );
    await expect(
      page.getByRole("progressbar", {
        name: /setup progress|tiến độ thiết lập/i,
      }),
    ).toHaveAttribute(
      "aria-valuenow",
      // 3/8 required steps: identity + the pre-seeded staff and catalog.
      // profile_complete makes public-booking PASS, but Preview remains
      // incomplete until its separate authenticated human rehearsal exists.
      "38",
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
    await expect(
      page.getByRole("progressbar", {
        name: /setup progress|tiến độ thiết lập/i,
      }),
    ).toHaveAttribute("aria-valuenow", "50");
    await expect(page.getByTestId("guided-setup-next-title")).toContainText(
      /Booking and cancellation rules|Quy định đặt và huỷ lịch/i,
    );

    await clearAppSessionCookies(page);
    await signInForDirectRoute(page, resumeOwner);
    await gotoAfterSignIn(page, `/dashboard/${RESUME_SLUG}/setup`);
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${RESUME_SLUG}/setup$`),
    );
    await expect(
      page.getByRole("progressbar", {
        name: /setup progress|tiến độ thiết lập/i,
      }),
    ).toHaveAttribute("aria-valuenow", "50");
    await expect(page.getByTestId("guided-setup-next-title")).toContainText(
      /Booking and cancellation rules|Quy định đặt và huỷ lịch/i,
    );
  });

  test("proves the safe preview is side-effect free before go-live approval", async ({
    page,
  }) => {
    if (!completeOwner) throw new Error("complete owner fixture missing");
    if (!completeSalonId) throw new Error("complete salon fixture missing");
    await configureTestGuidedAdminSetup(completeSalonId, true);
    activeGuidedSalonId = completeSalonId;

    await signInForDirectRoute(page, completeOwner);
    await gotoAfterSignIn(page, `/dashboard/${COMPLETE_SLUG}/setup`);
    await expect(page).toHaveURL(
      new RegExp(`/dashboard/${COMPLETE_SLUG}/setup$`),
      { timeout: 30_000 },
    );
    await expect(page.locator('[data-guided-setup-mode="true"]')).toBeVisible();
    await page.goto(`/dashboard/${COMPLETE_SLUG}/settings/readiness`);
    await expect(page.getByTestId("guided-setup-return-card")).toBeVisible();
    await expect(page.getByTestId("go-live-readiness-summary")).toContainText(
      /8\/8/,
    );

    const beforePreview = await guidedPreviewSideEffectSnapshot(completeSalonId);
    const unexpectedRequests: string[] = [];
    const observePreviewRequest = (request: { method(): string; url(): string }) => {
      const method = request.method().toUpperCase();
      const url = request.url();
      const pathname = new URL(url).pathname;
      if (
        (["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
          /\/api\/(?:booking|waitlist|otp|payment|stripe|square|voice|notification)/i.test(
            pathname,
          )) ||
        /(?:api\.stripe\.com|squareup\.com|twilio\.com|api\.resend\.com|api\.openai\.com|api\.anthropic\.com)/i.test(
          url,
        )
      ) {
        unexpectedRequests.push(`${method} ${url}`);
      }
    };
    page.on("request", observePreviewRequest);
    await page.goto(`/dashboard/${COMPLETE_SLUG}/setup/preview`);
    await expect(
      page.getByTestId("guided-booking-preview-simulator"),
    ).toHaveAttribute("data-preview-read-only", "true");
    await page.getByRole("button", { name: /continue|tiếp tục/i }).click();
    await expect(page.getByTestId("guided-preview-staff-step")).toBeVisible();
    await page.getByRole("button", { name: /continue|tiếp tục/i }).click();
    await expect(page.getByTestId("guided-preview-date-step")).toBeVisible();
    const previewDate = page
      .getByTestId("guided-preview-date-step")
      .locator('input[type="date"]');
    const firstDateYmd = await previewDate.getAttribute("min");
    if (!firstDateYmd) throw new Error("preview date window missing");
    const nextOpenDate = new Date(`${firstDateYmd}T12:00:00Z`);
    do {
      nextOpenDate.setUTCDate(nextOpenDate.getUTCDate() + 1);
    } while (nextOpenDate.getUTCDay() === 0);
    await previewDate.fill(nextOpenDate.toISOString().slice(0, 10));
    await page.getByRole("button", { name: /continue|tiếp tục/i }).click();
    await expect(page.getByTestId("guided-preview-time-step")).toBeVisible();
    await page
      .getByTestId("guided-preview-time-step")
      .locator("button:not([disabled])")
      .first()
      .click();
    await page.getByRole("button", { name: /continue|tiếp tục/i }).click();
    await expect(page.getByTestId("guided-preview-review-step")).toBeVisible();
    await expect(
      page.getByTestId("guided-preview-confirm-disabled"),
    ).toBeDisabled();
    page.off("request", observePreviewRequest);
    expect(unexpectedRequests).toEqual([]);
    const afterPreview = await guidedPreviewSideEffectSnapshot(completeSalonId);
    expect(afterPreview).toEqual(beforePreview);

    await page
      .getByTestId("guided-preview-evidence-note")
      .fill("Owner reviewed service, staff, date, and available time.");
    await page.getByTestId("guided-preview-record-proof").click();
    await expect(page.getByTestId("guided-preview-record-message")).toContainText(
      /recorded in the audit|ghi nhận preview chỉ đọc/i,
    );

    await page.goto(`/dashboard/${COMPLETE_SLUG}/settings/readiness`);
    await recordSafeGuidedAttestations(page);

    await page.goto(`/dashboard/${COMPLETE_SLUG}`);
    await expect(page.getByTestId("guided-admin-action-center")).toBeVisible();
    await expect(page.getByText(/Ready to operate|Sẵn sàng hoạt động/i)).toBeVisible();
  });

  test("denies the safe preview to lower roles and cross-tenant owners", async ({
    page,
  }) => {
    if (!completeReceptionist) {
      throw new Error("complete receptionist fixture missing");
    }
    if (!legacyOwner) throw new Error("legacy owner fixture missing");
    if (!completeSalonId) throw new Error("complete salon fixture missing");
    await configureTestGuidedAdminSetup(completeSalonId, true);
    activeGuidedSalonId = completeSalonId;

    await signInForDirectRoute(page, completeReceptionist);
    await gotoAfterSignIn(page, `/dashboard/${COMPLETE_SLUG}/setup/preview`);
    await expect(page).not.toHaveURL(
      new RegExp(`/dashboard/${COMPLETE_SLUG}/setup/preview$`),
    );
    await expect(
      page.getByTestId("guided-booking-preview-simulator"),
    ).toHaveCount(0, { timeout: 30_000 });

    await clearAppSessionCookies(page);
    await loginAs(page, legacyOwner);
    await page.goto(`/dashboard/${COMPLETE_SLUG}/setup/preview`);
    await expect(page).not.toHaveURL(
      new RegExp(`/dashboard/${COMPLETE_SLUG}/setup/preview$`),
    );
    await expect(
      page.getByTestId("guided-booking-preview-simulator"),
    ).toHaveCount(0, { timeout: 30_000 });
  });

  test("keeps the original dashboard navigation when Guided Setup is disabled", async ({
    page,
  }) => {
    if (!legacyOwner) throw new Error("legacy owner fixture missing");

    await signInForDirectRoute(page, legacyOwner);
    await gotoAfterSignIn(page, `/dashboard/${LEGACY_SLUG}/setup/address`);
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
    if (!surfacesSalonId) throw new Error("surfaces salon fixture missing");
    await configureTestGuidedAdminSetup(surfacesSalonId, true);
    activeGuidedSalonId = surfacesSalonId;

    await signInForDirectRoute(page, surfacesAdmin);
    await gotoAfterSignIn(page, `/dashboard/${SURFACES_SLUG}/setup`);
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

    for (const [stepId] of destinations) {
      await expect(
        page.getByTestId(`guided-setup-step-${stepId}`),
      ).toBeVisible();
    }
    await expect(page.getByTestId("guided-setup-next")).toHaveAttribute(
      "href",
      `/dashboard/${SURFACES_SLUG}/setup/preview`,
    );
    await expect(
      page.getByTestId("guided-setup-step-booking-preview"),
    ).toHaveAttribute("aria-current", "step");
    for (const [stepId] of destinations) {
      await expect(
        page.getByTestId(`guided-setup-step-${stepId}`),
      ).toHaveAttribute("aria-disabled", "true");
    }

    await expect(
      page.getByTestId("guided-setup-step-integrations"),
    ).toContainText(/Skipped(?: for now)?|Đã bỏ qua/i);
    const progressBefore = await page
      .getByRole("progressbar", {
        name: /setup progress|tiến độ thiết lập/i,
      })
      .getAttribute("aria-valuenow");

    await gotoAfterSignIn(page, `/dashboard/${SURFACES_SLUG}/setup/hours`);
    await page.getByTestId("hours-preset-standard").click();
    const holidayButton = page.getByTestId("hours-holiday-2026-12-25");
    const closedDatesInput = page
      .getByTestId("hours-holiday-presets")
      .locator("..")
      .locator("textarea");
    // The holiday chips are present in streamed HTML before their onClick is
    // hydrated. Prove the controlled textarea changed before asking autosave
    // or Save all to persist it.
    await expect(async () => {
      await holidayButton.click();
      await expect(closedDatesInput).toHaveValue(/2026-12-25/);
    }).toPass({ timeout: 15_000 });
    await page.getByRole("button", { name: /Save all|Lưu tất cả/i }).click();
    // Guided mode can auto-save 900ms after the edit, racing the explicit
    // button and making its short-lived toast disappear during router.refresh.
    // The durable database value is the actual contract for this step.
    await expect.poll(async () => {
      const { data, error } = await createServiceRoleClient()
        .from("salons")
        .select("booking_closed_dates")
        .eq("id", surfacesSalonId)
        .single();
      if (error) return false;
      const dates = (data as { booking_closed_dates?: unknown }).booking_closed_dates;
      return Array.isArray(dates) && dates.includes("2026-12-25");
    }, { timeout: 15_000 }).toBe(true);

    await gotoAfterSignIn(page, `/dashboard/${SURFACES_SLUG}/setup/staff`);
    await expect(page.getByText("Jenny", { exact: true })).toBeVisible();
    await expect(page.getByText(/Nail tech|Thợ nail|Thợ phụ/i)).toBeVisible();
    await expect(
      page.locator('[data-testid^="staff-edit-"]').first(),
    ).toBeVisible();
    const staffEditButtons = page.locator('[data-testid^="staff-edit-"]');
    await proveControlledSearchHydrated(
      page.getByRole("searchbox"),
      staffEditButtons,
    );
    await staffEditButtons.first().click();
    const staffDrawer = page.getByRole("dialog");
    await expect(staffDrawer).toBeVisible({ timeout: 10_000 });
    await expect(staffDrawer.getByTestId("staff-drawer-name")).toHaveValue(
      "Jenny",
    );
    await staffDrawer.getByTestId("staff-drawer-name").fill("Jenny QA");
    await staffDrawer
      .getByRole("button", { name: /^(save|lưu)$/i })
      .click();
    await expect(page.getByText("Jenny QA", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText("Jenny QA", { exact: true })).toBeVisible();

    await gotoAfterSignIn(page, `/dashboard/${SURFACES_SLUG}/setup/services`);
    await expect(page.getByText("Gel Manicure", { exact: true })).toBeVisible();
    await expect(page.getByText(/\$45(?:\.00)?/).first()).toBeVisible();
    await expect(
      page.locator('[data-testid^="service-edit-"]').first(),
    ).toBeVisible();
    const serviceEditButtons = page.locator('[data-testid^="service-edit-"]');
    await proveControlledSearchHydrated(
      page.getByRole("searchbox"),
      serviceEditButtons,
    );
    await serviceEditButtons.first().click();
    const serviceDrawer = page.getByRole("dialog");
    await expect(serviceDrawer).toBeVisible({ timeout: 10_000 });
    await expect(
      serviceDrawer.getByTestId("service-drawer-duration"),
    ).toHaveValue(
      "45",
    );
    await serviceDrawer.getByTestId("service-drawer-price").fill("46");
    await serviceDrawer
      .getByRole("button", { name: /^(save|lưu)$/i })
      .click();
    // The price preview inside the drawer updates immediately while the server
    // action is still running. Wait for onSaved to close the drawer before
    // reading the list or reloading; otherwise mobile WebKit can abort the
    // in-flight persistence request even though the optimistic $46 is visible.
    await expect(page.getByTestId("service-drawer-price")).toBeHidden({
      timeout: 15_000,
    });
    await expect(page.getByText(/\$46(?:\.00)?/).first()).toBeVisible();
    // Reload once after confirmed save, then verify the persisted server value.
    await page.reload();
    await expect(page.getByText(/\$46(?:\.00)?/).first()).toBeVisible({
      timeout: 15_000,
    });

    await gotoAfterSignIn(
      page,
      `/dashboard/${SURFACES_SLUG}/no-show-protection`,
    );
    await expect(page.getByTestId("guided-policy-en")).toHaveValue(
      "Please contact the salon before cancelling or rescheduling.",
    );
    await expect(page.getByTestId("guided-policy-vi")).toHaveValue(
      "Vui lòng liên hệ salon trước khi huỷ hoặc đổi lịch.",
    );
    await expect(page.getByTestId("guided-booking-policy-only")).toBeVisible();
    await expect(page.getByTestId("guided-policy-group-status")).toContainText(
      /optional|không bắt buộc/i,
    );
    await expect(
      page.getByTestId("guided-policy-after-hours-status"),
    ).toContainText(/Owner\/Admin|Owner|Admin/i);
    // This fixture is an Admin. It can review and configure salon policy. The
    // whole-party control is conditional on no-show protection being enabled;
    // the late-cancellation window remains visible for policy review.
    await expect(page.getByTestId("noshow-whole-party-toggle")).toHaveCount(0);
    await expect(page.getByTestId("self-cancel-fee-toggle")).toHaveCount(0);
    await expect(page.getByTestId("self-cancel-window-hours")).toHaveCount(0);

    await gotoAfterSignIn(
      page,
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
      await gotoAfterSignIn(page, href);
      await expect(page.getByTestId("guided-setup-return-card")).toBeVisible();
    }

    await gotoAfterSignIn(page, `/dashboard/${SURFACES_SLUG}/setup/preview`);
    await expect(page.getByTestId("guided-booking-preview")).toContainText(
      /Side-effect-free booking preview|Preview booking không tạo side effect/i,
    );
    await expect(page.getByTestId("guided-open-public-booking")).toHaveCount(0);
    await expect(page.getByTestId("guided-preview-continue")).toHaveCount(0);

    await gotoAfterSignIn(page, `/dashboard/${SURFACES_SLUG}/setup`);
    await expect(
      page.getByRole("progressbar", {
        name: /setup progress|tiến độ thiết lập/i,
      }),
    ).toHaveAttribute("aria-valuenow", progressBefore ?? "");
  });
});
