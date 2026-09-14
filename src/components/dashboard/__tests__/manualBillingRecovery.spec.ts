import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ checkout: vi.fn(), portal: vi.fn() }));
vi.mock("@/shared/dashboard/stripeActions", () => ({
  createCheckoutSession: m.checkout,
  createCustomerPortalSession: m.portal,
}));

import { PricingPanel } from "../PricingPanel";
import { SubscriptionDeadlineNotice } from "../SubscriptionDeadlineNotice";
import { userEn } from "@/shared/i18n/user/en";
import { userVi } from "@/shared/i18n/user/vi";
import { v1AllowsAutomatedSubscriptionBilling } from "@/shared/release/v1IntegrationScope";

describe("V1 manual subscription recovery", () => {
  it("replaces the unavailable checkout link with contact without claiming access is restored", () => {
    expect(v1AllowsAutomatedSubscriptionBilling()).toBe(false);
    const html = renderToStaticMarkup(createElement(SubscriptionDeadlineNotice, {
      salonName: "E2E Salon A", offerUrl: "/offer/synthetic-private-offer",
    }));
    expect(html).toContain('href="/contact"');
    expect(html).toContain("Dashboard access is paused");
    expect(html).toContain("Liên hệ NailIQ");
    expect(html).not.toContain("synthetic-private-offer");
    expect(html).not.toContain("restore access automatically");
    expect(html).not.toContain("July 31");
  });

  for (const [locale, copy] of [["en", userEn], ["vi", userVi]] as const) {
    it.each(["free", "pro", "premium"] as const)(`${locale} %s plan offers a truthful manual path with no inactive checkout control`, (plan) => {
      const messages = copy.receptionist.pricing;
      const html = renderToStaticMarkup(createElement(PricingPanel, {
        slug: "e2e-billing-recovery", currentPlan: plan, messages,
      }));
      expect(html).toContain(messages.manualBillingNotice);
      expect(html).toContain(messages.contactSupport);
      expect(html).toContain('href="/contact"');
      expect(html).toContain('data-testid="pricing-manual-billing"');
      expect(html).not.toContain('data-testid="pricing-upgrade-');
      expect(html).not.toContain('data-testid="pricing-manage-');
      expect(html).not.toContain('data-testid="pricing-error"');
      expect(m.checkout).not.toHaveBeenCalled();
      expect(m.portal).not.toHaveBeenCalled();
    });
  }
});
