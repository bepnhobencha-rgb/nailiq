import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  V1_INTEGRATION_SCOPE,
  v1AllowsArchivedBookingRecovery,
  v1AllowsAutomatedSubscriptionBilling,
  v1AllowsCustomerPaymentGateway,
  v1AllowsWixCalendarConnection,
} from "../v1IntegrationScope";

describe("NailIQ V1 integration scope", () => {
  it("keeps money provider-owned and moves external sync to Phase 2", () => {
    expect(V1_INTEGRATION_SCOPE).toEqual({
      paymentGatewayIntegration: "phase_2_provider_terminal",
      nailiqSubscriptionAutomation: "phase_2_manual_billing_v1",
      googleCalendarSync: "phase_2",
      outlookCalendarSync: "phase_2",
      wixCalendarSync: "legacy_existing_only",
      squareLoyaltySync: "phase_2_provider_owned",
      squareGiftCardSync: "phase_2_provider_owned",
      archivedBookingRecovery: "phase_2",
    });
  });

  it("blocks new Wix connections while preserving existing live compatibility", () => {
    expect(v1AllowsWixCalendarConnection(false)).toBe(false);
    expect(v1AllowsWixCalendarConnection(true)).toBe(true);
  });

  it("keeps NailIQ-initiated customer money paths hard off in V1", () => {
    expect(v1AllowsCustomerPaymentGateway()).toBe(false);

    const paymentResolver = readFileSync(
      resolve(process.cwd(), "src/shared/integrations/payments/index.ts"),
      "utf8",
    );
    const deposits = readFileSync(
      resolve(process.cwd(), "src/shared/integrations/square/deposits.ts"),
      "utf8",
    );
    const noShow = readFileSync(
      resolve(process.cwd(), "src/shared/integrations/square/noshow.ts"),
      "utf8",
    );

    expect(paymentResolver).toMatch(
      /resolvePaymentProvider[\s\S]*v1AllowsCustomerPaymentGateway\(\)[\s\S]*return null/u,
    );
    expect(deposits).toMatch(
      /createDepositForBooking[\s\S]*phase_2_not_available[\s\S]*createServiceRoleClient/u,
    );
    expect(noShow).toMatch(
      /createNoShowFeeLink[\s\S]*phase_2_not_available[\s\S]*looseServiceClient/u,
    );
  });

  it("keeps NailIQ subscription automation hard off before provider or database mutation", () => {
    expect(v1AllowsAutomatedSubscriptionBilling()).toBe(false);

    const dashboardActions = readFileSync(
      resolve(process.cwd(), "src/shared/dashboard/stripeActions.ts"),
      "utf8",
    );
    const offerAction = readFileSync(
      resolve(process.cwd(), "src/app/offer/[token]/actions.ts"),
      "utf8",
    );
    const offerPage = readFileSync(
      resolve(process.cwd(), "src/app/offer/[token]/page.tsx"),
      "utf8",
    );
    const offerSuccess = readFileSync(
      resolve(process.cwd(), "src/app/offer/[token]/success/page.tsx"),
      "utf8",
    );
    const webhook = readFileSync(
      resolve(process.cwd(), "src/app/api/stripe/webhook/route.ts"),
      "utf8",
    );

    expect(dashboardActions).toMatch(
      /createCheckoutSession[\s\S]*v1AllowsAutomatedSubscriptionBilling\(\)[\s\S]*phase_2_not_available[\s\S]*priceIdForPlan/u,
    );
    expect(dashboardActions).toMatch(
      /createCustomerPortalSession[\s\S]*v1AllowsAutomatedSubscriptionBilling\(\)[\s\S]*phase_2_not_available[\s\S]*getStripeClient/u,
    );
    expect(offerAction).toMatch(
      /startPrivateOfferCheckout[\s\S]*v1AllowsAutomatedSubscriptionBilling\(\)[\s\S]*phase-2[\s\S]*getStripeClient/u,
    );
    expect(offerPage).toMatch(
      /v1AllowsAutomatedSubscriptionBilling\(\)[\s\S]*notFound\(\)/u,
    );
    expect(offerSuccess).toMatch(
      /v1AllowsAutomatedSubscriptionBilling\(\)[\s\S]*notFound\(\)[\s\S]*getStripeClient/u,
    );
    expect(webhook).toMatch(
      /constructEvent[\s\S]*v1AllowsAutomatedSubscriptionBilling\(\)[\s\S]*V1_DEFERRED_SUBSCRIPTION_EVENTS\.has\(event\.type\)[\s\S]*phase_2_subscription[\s\S]*checkout\.session\.completed/u,
    );
  });

  it("keeps Archived Booking Recovery hard off across V1 UI and writes", () => {
    expect(v1AllowsArchivedBookingRecovery()).toBe(false);

    const access = readFileSync(
      resolve(
        process.cwd(),
        "src/shared/dashboard/archivedBookingFeatureAccess.ts",
      ),
      "utf8",
    );
    const actions = readFileSync(
      resolve(process.cwd(), "src/shared/dashboard/receptionistActions.ts"),
      "utf8",
    );
    const centerPage = readFileSync(
      resolve(process.cwd(), "src/app/dashboard/[slug]/center/page.tsx"),
      "utf8",
    );

    expect(access).toMatch(
      /isArchivedBookingFeatureAvailable[\s\S]*v1AllowsArchivedBookingRecovery\(\)[\s\S]*return false[\s\S]*isReleaseFeatureVisible/u,
    );
    expect(actions).toMatch(
      /archivedBookingRecoveryEnabled[\s\S]*v1AllowsArchivedBookingRecovery\(\)[\s\S]*return false[\s\S]*createServiceRoleClient/u,
    );
    expect(centerPage).toMatch(
      /archivedBookingRecoveryEnabled\s*=\s*[\s\S]*isArchivedBookingFeatureAvailable\(ctx\.salon\)/u,
    );
  });

  it("places the V1 guard before Wix provider tests and credential upserts", () => {
    const actions = readFileSync(
      resolve(
        process.cwd(),
        "src/shared/integrations/wix/admin/adminActions.ts",
      ),
      "utf8",
    );
    const settings = readFileSync(
      resolve(process.cwd(), "src/components/dashboard/WixIntegrationSettings.tsx"),
      "utf8",
    );

    expect(actions).toMatch(
      /testWixConnection[\s\S]*phase_2_not_available[\s\S]*wixPostWithKey/u,
    );
    expect(actions).toMatch(
      /saveWixCredentials[\s\S]*phase_2_not_available[\s\S]*\.upsert\(patch/u,
    );
    expect(settings).toContain('data-testid="settings-wix-phase-2"');
    expect(settings).toContain("Legacy compatibility");
  });
});
