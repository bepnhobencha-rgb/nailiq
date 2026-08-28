/**
 * E2E tests for the phone OTP verification step in the booking flow.
 * Requires DEMO_OTP=true (set in .env.test.local) — uses magic code 000000.
 */
import { test, expect } from "@playwright/test";
import {
  cleanupClientProfile,
  cleanupTestSalon,
  completeBookingEntryGate,
  completeGateOtp,
  seedTestSalon,
  setReactInputValue,
} from "./helpers/db";
import { advanceBookingStep } from "./helpers/bookingFlow";
import { fillReactInput } from "./receptionist-center/helpers";

const OTP_DEMO_CODE = "000000";

/**
 * Unique guest phone per test.
 *
 * Each test must arrive as a brand-new customer (visit_count 0) so the
 * `always_otp` salon actually routes through OTP. A fixed phone accumulates
 * `visit_count` across CI runs in the cross-salon `client_profiles` table;
 * once it reaches >= 5 the RPC returns reason:"trusted_returning" and skips
 * OTP. A per-test phone (combined with the afterEach `cleanupClientProfile`)
 * keeps each run starting fresh and prevents the row from ever accumulating.
 *
 * Stays NANP-valid: area `604` + exchange `5xx` + 4 digits (both leading
 * groups in 2-9, per normalizeNanpDigits).
 */
let otpPhoneSeq = 0;
function uniqueOtpPhone(): string {
  const n = (Date.now() + otpPhoneSeq++) % 1_000_000;
  const exchange = 500 + (Math.floor(n / 10_000) % 100); // 500–599
  const last4 = String(n % 10_000).padStart(4, "0");
  return `604${exchange}${last4}`;
}

test.describe("Booking Flow — Phone OTP", () => {
  let testSlug: string;
  let clientPhone: string;

  test.beforeEach(async () => {
    clientPhone = uniqueOtpPhone();
    // Defensive: clear any stale profile for this phone before the test runs.
    await cleanupClientProfile(clientPhone);
    const { slug } = await seedTestSalon({
      slug: "e2e-otp-salon",
      name: "E2E OTP Salon",
      phone: "16045550001",
      // Public contact number displayed as tel:// link on the OTP screen when
      // SMS doesn't arrive (A2P mitigation). Separate from salons.phone (owner).
      salon_phone: "16045550001",
      phone_otp_enabled: true,
      // always_otp ensures the verify-decision RPC routes every booking through
      // the OTP step regardless of risk score (needed for predictable E2E tests).
      booking_verification_mode: "always_otp",
    });
    testSlug = slug;
  });

  test.afterEach(async () => {
    await cleanupTestSalon(testSlug);
    // Remove the guest profile so visit_count never accumulates across runs.
    await cleanupClientProfile(clientPhone);
  });

  // Salon is phone_otp_enabled + always_otp, so OTP now lives at the ENTRY GATE
  // (commit a4042c5 "gate-first OTP" / cfae253 "move gate OTP inline"): the gate
  // takes phone + name + SMS consent, then the gate OTP, and only then does the
  // service step unlock (`flowReady = gateReady && gateOtpDone`). The old
  // post-info `#otp-code` step (BookingFlowOtpPanel) is unreachable for this flow.
  async function gotoGate(page: import("@playwright/test").Page) {
    await page.goto(`/${testSlug}`);
    // Per-test phone (a new customer, cleaned in beforeEach) so the gate name
    // input shows and `always_otp` routes this booking through the gate OTP.
    await completeBookingEntryGate(page, { phone: clientPhone });
  }

  // Clear the gate OTP (send + demo code) and confirm the flow unlocked.
  async function passGateOtp(page: import("@playwright/test").Page) {
    await completeGateOtp(page);
    await page
      .locator('[data-testid="service-tile-select"]')
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
  }

  async function walkToInfoStep(page: import("@playwright/test").Page) {
    await gotoGate(page);
    await passGateOtp(page);
    const serviceStep = page.locator(
      'section[aria-labelledby="svc-heading"]',
    );
    await serviceStep
      .locator('[data-testid="service-tile-select"]')
      .first()
      .click();
    await serviceStep.getByRole("button", { name: "Continue" }).click();

    const staffStep = page.locator(
      'section[aria-labelledby="staff-heading"]',
    );
    await staffStep
      .locator('[data-testid="staff-item"]')
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await staffStep.locator('[data-testid="staff-item"]').first().click();
    await staffStep.getByRole("button", { name: "Continue" }).click();

    // Robust date pick (mirrors PR #211): the calendar opens on the first month
    // with availability, but late in the month the current view can hold only
    // "today" (rendered as `date-today`, not `date-day`). Advance a month until
    // a selectable `date-day` appears instead of assuming the default view has
    // one — keeps the OTP suite deterministic on the last day of the month.
    // The month grid is collapsed behind the "📅 More dates" toggle (#593).
    const dateStep = page.locator(
      'section[aria-labelledby="date-heading"]',
    );
    await dateStep.locator('[data-testid="date-toggle-calendar"]').click();
    await dateStep
      .locator('[data-testid="calendar-grid"]')
      .waitFor({ state: "visible", timeout: 15_000 });
    const selectableDay = dateStep
      .locator('[data-testid="date-day"]:not([disabled])')
      .first();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await selectableDay.waitFor({ state: "visible", timeout: 5_000 });
        break;
      } catch {
        const next = dateStep.locator('[data-testid="calendar-next-month"]');
        if (!(await next.isEnabled().catch(() => false))) break;
        await next.click();
      }
    }
    await selectableDay.waitFor({ state: "visible", timeout: 15_000 });
    await selectableDay.click();
    await expect(selectableDay).toHaveAttribute("aria-pressed", "true");
    await dateStep.getByRole("button", { name: "Continue" }).click();

    const timeStep = page.locator(
      'section[aria-labelledby="time-heading"]',
    );
    const firstAvailableSlot = timeStep
      .locator('[data-testid="time-slot"]:not([disabled])')
      .first();
    await firstAvailableSlot.waitFor({ state: "visible", timeout: 20_000 });
    await firstAvailableSlot.click();
    await expect(firstAvailableSlot).toHaveAttribute("aria-pressed", "true");
    const infoStep = page.locator(
      'section[aria-labelledby="info-heading"]',
    );
    await advanceBookingStep(timeStep, infoStep);

    // Phone-first: phone captured at the entry gate; info step takes name only.
    // Use the native setter so React's controlled onChange fires (page.fill()
    // uses CDP which bypasses React's patched value getter).
    await fillReactInput(
      infoStep.locator('input[name="clientName"]'),
      "OTP Test Client",
    );
  }

  test("gate OTP appears before the service step and accepts the demo code", async ({
    page,
  }) => {
    await gotoGate(page);

    // Security invariant (a): OTP is demanded at the GATE, and the service step
    // must NOT be reachable until the phone is verified.
    await expect(page.getByTestId("booking-gate-otp")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="service-tile-select"]')).toHaveCount(0);

    // Demo code → gate opens → the service step unlocks.
    await completeGateOtp(page);
    await expect(
      page.locator('[data-testid="service-tile-select"]').first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("gate OTP rejects a wrong code and accepts the correct one", async ({ page }) => {
    await gotoGate(page);
    // Reach the code input (sent stage) by requesting the code.
    await page.getByTestId("booking-gate-otp-send").click();
    const codeInput = page.getByTestId("booking-gate-otp-input");
    await codeInput.waitFor({ state: "visible", timeout: 15_000 });

    // Security invariant (b): a wrong code is rejected and the flow stays locked.
    // 6 digits auto-fires verifyCode() (GateOtpInline.onCodeChange).
    await setReactInputValue(codeInput, "999999");
    await expect(page.getByTestId("booking-gate-otp-error")).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('[data-testid="service-tile-select"]')).toHaveCount(0);

    // Correct demo code → gate opens.
    await setReactInputValue(codeInput, OTP_DEMO_CODE);
    await expect(
      page.locator('[data-testid="service-tile-select"]').first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  // Was "Back button from OTP returns to info step". The gate OTP is inline in
  // the phone card, not a separate step with a Back button, so that premise is
  // gone. The equivalent — and more important — invariant is that editing the
  // phone AFTER verifying re-locks the gate and forces a fresh OTP (the reactive
  // reset in BookingTypeSwitcher clears gateOtpDone on any phone change).
  test("editing the phone after verify re-locks the gate and re-demands OTP", async ({
    page,
  }) => {
    await gotoGate(page);
    await completeGateOtp(page);
    await expect(
      page.locator('[data-testid="service-tile-select"]').first(),
    ).toBeVisible({ timeout: 15_000 });

    // Change to a different valid phone → gateOtpDone resets → flow re-locks and
    // the gate OTP is demanded again. A verified session cannot carry to a new phone.
    await setReactInputValue(page.getByTestId("booking-entry-phone"), uniqueOtpPhone());
    await expect(page.locator('[data-testid="service-tile-select"]')).toHaveCount(0);
    await expect(page.getByTestId("booking-gate-otp")).toBeVisible({ timeout: 8_000 });
  });

  test("full booking completes after gate OTP verification", async ({ page }) => {
    // walkToInfoStep now clears the gate (phone + name + consent + gate OTP) and
    // walks service/staff/date/time/info.
    await walkToInfoStep(page);
    await page.getByRole("button", { name: "Continue" }).first().click();

    // Gate OTP already satisfied → straight to confirm; no post-info OTP step.
    const confirmBtn = page.getByRole("button", { name: /confirm booking|xác nhận/i });
    await confirmBtn.waitFor({ state: "visible", timeout: 15_000 });
    // SMS consent was collected at the gate; tick a confirm-step checkbox only if
    // one is still shown (it is pre-satisfied for the gate flow).
    const consent = page.getByTestId("sms-consent");
    if (await consent.isVisible().catch(() => false)) await consent.check();
    await confirmBtn.click();

    // Success screen
    await expect(
      page.locator('[data-testid="booking-success"]'),
    ).toBeVisible({ timeout: 20_000 });
  });

  // Anti-double-charge regression — the phone is verified ONCE at the gate, and
  // navigating within the flow (info ↔ confirm) must never re-send a code nor
  // re-open the gate OTP. One gate send, and it stays verified.
  test("a verified phone is not re-texted when navigating within the flow", async ({
    page,
  }) => {
    let sendCount = 0;
    await page.route("**/api/booking-otp/send", async (route) => {
      if (route.request().method() === "POST") sendCount += 1;
      await route.continue();
    });

    // walkToInfoStep clears the gate incl. exactly one gate OTP send.
    await walkToInfoStep(page);
    await page.getByRole("button", { name: "Continue" }).first().click();

    const confirmBtn = page.getByRole("button", { name: /confirm booking|xác nhận/i });
    await confirmBtn.waitFor({ state: "visible", timeout: 15_000 });
    const sendsAfterVerify = sendCount; // one send, from the gate OTP

    // Back to info, then forward to confirm again → phone stays verified, the
    // gate OTP does NOT reappear, and NO additional SMS is sent.
    await page.getByRole("button", { name: /← back|back|quay l/i }).click();
    await expect(page.locator('input[name="clientName"]')).toBeVisible({
      timeout: 8_000,
    });
    await page.getByRole("button", { name: "Continue" }).first().click();
    await expect(confirmBtn).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("booking-gate-otp")).toHaveCount(0);
    expect(sendCount).toBe(sendsAfterVerify);
  });

  // A2P mitigation (restored, #762): the gate OTP widget must offer a tel://
  // "call to book" link so an SMS-dropped customer can still book. It was lost
  // when OTP moved to the gate; GateOtpInline now renders it from salon.salonPhone.
  test("salon phone tel:// call-to-book link visible on the gate OTP screen", async ({
    page,
  }) => {
    await gotoGate(page);
    await page.getByTestId("booking-gate-otp-send").click();
    await page
      .getByTestId("booking-gate-otp-input")
      .waitFor({ state: "visible", timeout: 15_000 });

    // The tel:// link should appear (salon seeded with phone "16045550001").
    const callLink = page.locator('a[href^="tel:"]');
    await expect(callLink).toBeVisible({ timeout: 8_000 });
    const href = await callLink.getAttribute("href");
    expect(href).toContain("16045550001");
  });

  // Email fallback must be offered on the gate OTP screen so customers who don't
  // receive the SMS can still get a code by email.
  test("email fallback is offered on the gate OTP screen", async ({ page }) => {
    await gotoGate(page);
    await page.getByTestId("booking-gate-otp-send").click();
    await page
      .getByTestId("booking-gate-otp-input")
      .waitFor({ state: "visible", timeout: 15_000 });

    await expect(
      page.getByTestId("booking-gate-otp-email-fallback"),
    ).toBeVisible({ timeout: 8_000 });
  });

  test("email-only OTP receipt stays truthful and can switch explicitly to SMS", async ({
    page,
  }) => {
    const channels: string[] = [];
    const verifyBodies: Array<Record<string, string>> = [];
    const smsAttemptId = "77777777-7777-4777-8777-777777777777";
    await page.route("**/api/booking-otp/send", async (route) => {
      const body = route.request().postDataJSON() as { channel?: string };
      const requestedChannel = body.channel ?? "sms";
      channels.push(requestedChannel);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          deliveryAttemptId: requestedChannel === "sms"
            ? smsAttemptId
            : "88888888-8888-4888-8888-888888888888",
        }),
      });
    });
    await page.route("**/api/booking-otp/verify", async (route) => {
      verifyBodies.push(route.request().postDataJSON() as Record<string, string>);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          sessionId: "99999999-9999-4999-8999-999999999999",
        }),
      });
    });

    await gotoGate(page);
    await page.getByTestId("booking-gate-otp-email-fallback").click();
    await page
      .getByTestId("booking-gate-otp-email-input")
      .fill("otp-truth@example.test");
    await page.getByTestId("booking-gate-otp-email-send").click();

    const emailReceipt = page.getByTestId("booking-gate-otp-delivery-email");
    await expect(emailReceipt).toBeVisible();
    await expect(emailReceipt).toContainText("o•••@example.test");
    await expect(emailReceipt).not.toContainText(clientPhone.slice(-4));
    expect(channels).toEqual(["email"]);

    await page.getByTestId("booking-gate-otp-sms-send").click();
    const smsReceipt = page.getByTestId("booking-gate-otp-delivery-sms");
    await expect(smsReceipt).toBeVisible();
    await expect(smsReceipt).toContainText(clientPhone.slice(-4));
    expect(channels).toEqual(["email", "sms"]);

    await page.getByTestId("booking-gate-otp-input").fill("123456");
    await expect.poll(() => verifyBodies.length).toBe(1);
    expect(verifyBodies[0]?.deliveryAttemptId).toBe(smsAttemptId);
  });

  // Regression — the SMS send endpoint must throttle bursts server-side (the
  // client cooldown is bypassable). The current recovery contract permits five
  // attempts per phone/window; the sixth is rejected 429 rate_limited. Runs in
  // demo mode (the guard sits before the demo short-circuit), so no SMS is sent.
  test("server throttles duplicate SMS sends to the same phone", async ({
    request,
  }) => {
    const phone = uniqueOtpPhone();
    const data = { phone, shopSlug: testSlug };

    const r1 = await request.post("/api/booking-otp/send", { data });
    expect(r1.status()).toBe(200);

    for (let attempt = 2; attempt <= 5; attempt += 1) {
      const allowed = await request.post("/api/booking-otp/send", { data });
      expect(allowed.status()).toBe(200);
    }

    const limited = await request.post("/api/booking-otp/send", { data });
    expect(limited.status()).toBe(429);
    expect((await limited.json()).error).toBe("rate_limited");
  });
});
