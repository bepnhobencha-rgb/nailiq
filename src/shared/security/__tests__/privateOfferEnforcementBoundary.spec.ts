import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("Hi-Lite private-offer enforcement boundary", () => {
  it("keeps offer identity server-only and binds every offer to one salon", () => {
    const offers = read("src/shared/sales/privateOffers.ts");
    expect(offers).toContain('import "server-only"');
    expect(offers).toContain('salonSlug: "hilite-anaheim"');
    expect(offers).toContain("monthlyAmountCents: 19_900");
    expect(offers).toContain("monthlySetupAmountCents: 29_900");
    expect(offers).toContain("OFFER_TOKEN_HILITE_HEAD_SPA");
    expect(offers).toContain('salonSlug: "hilite-studio"');
    expect(offers).toContain("monthlyAmountCents: 14_900");
    expect(offers).toContain("quarterlyAmountCents: 44_700");
    expect(offers).toContain("semiannualAmountCents: 89_400");
    expect(offers).toContain("OFFER_TOKEN_HILITE_STUDIO");
    expect(offers).toContain("getPrivateOfferBySalonId");
  });

  it("charges the setup fee exactly once for monthly billing only", () => {
    const action = read("src/app/offer/[token]/actions.ts");
    const page = read("src/app/offer/[token]/page.tsx");
    expect(action).toContain("billing.setupFeeAmountCents > 0");
    expect(action).toContain("unit_amount: billing.setupFeeAmountCents");
    expect(action).toContain("NailIQ one-time setup");
    expect(action).toContain("setup_fee_cents: String(setupFeeAmountCents)");
    expect(page).toContain("{monthly}/month + {monthlySetup} setup once");
    expect(page).toContain(
      "Setup is waived for every other available schedule",
    );
  });

  it("locks only Dashboard rendering and unlocks from persisted Stripe truth", () => {
    const layout = read("src/app/dashboard/[slug]/layout.tsx");
    expect(layout).toContain("getPrivateOfferBySalonId(ctx.salon.id)");
    expect(layout).toContain(
      'select("stripe_subscription_id, subscription_status")',
    );
    expect(layout).toContain('status === "active" || status === "trialing"');
    expect(layout).toContain("SubscriptionDeadlineNotice");
    expect(layout).not.toContain("redirect(privateOffer");
  });

  it("requires matching email and explicit agreement before Stripe checkout", () => {
    const action = read("src/app/offer/[token]/actions.ts");
    const offers = read("src/shared/sales/privateOffers.ts");
    expect(action).toContain('.in("role", ["owner", "admin"])');
    expect(action).toContain("authorizedEmails.includes(signerEmail)");
    expect(action).toContain(
      "!accepted || !authorityAccepted || !renewalAccepted",
    );
    expect(action).toContain("client_reference_id: offer.salonId");
    expect(action).toContain("private_offer_identity: offerIdentity");
    expect(action).not.toContain("private_offer_key: offer.accessKey");
    expect(action).toContain("subscription_data: { metadata }");
    expect(offers).toContain('schedule === "quarterly"');
    expect(offers).toContain("intervalCount: 3");
    expect(offers).toContain('schedule === "semiannual"');
    expect(offers).toContain("intervalCount: 6");
    expect(action).toContain("claimStripeSubscriptionCheckout({");
    expect(action).toContain("stripeCheckoutRequestFingerprint({");
    expect(action).toContain("amountCents: billing.amountCents");
    expect(action).toContain("currency: billing.currency");
    expect(action).toContain("interval: billing.interval");
    expect(action).toContain("offerIdentity,");
    expect(
      action.indexOf("authorizedEmails.includes(signerEmail)"),
    ).toBeLessThan(action.indexOf("claimStripeSubscriptionCheckout({"));
  });

  it("shows 3- and 6-month no-discount schedules only when configured", () => {
    const page = read("src/app/offer/[token]/page.tsx");
    expect(page).toContain('value="quarterly"');
    expect(page).toContain("{quarterly}/3 months · no discount");
    expect(page).toContain('value="semiannual"');
    expect(page).toContain("{semiannual}/6 months · no discount");
  });

  it("does not prefill or render the private recipient email", () => {
    const page = read("src/app/offer/[token]/page.tsx");
    expect(page).not.toContain("offer.customerEmail");
    expect(page).not.toContain("defaultValue=");
  });
});
