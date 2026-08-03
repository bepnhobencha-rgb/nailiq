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
    expect(offers).toContain('monthlyAmountCents: 19_900');
    expect(offers).toContain("OFFER_TOKEN_HILITE_HEAD_SPA");
    expect(offers).toContain('salonSlug: "hilite-studio"');
    expect(offers).toContain('monthlyAmountCents: 14_900');
    expect(offers).toContain("OFFER_TOKEN_HILITE_STUDIO");
    expect(offers).toContain("getPrivateOfferBySalonId");
  });

  it("locks only Dashboard rendering and unlocks from persisted Stripe truth", () => {
    const layout = read("src/app/dashboard/[slug]/layout.tsx");
    expect(layout).toContain("getPrivateOfferBySalonId(ctx.salon.id)");
    expect(layout).toContain('select("stripe_subscription_id, subscription_status")');
    expect(layout).toContain('status === "active" || status === "trialing"');
    expect(layout).toContain("SubscriptionDeadlineNotice");
    expect(layout).not.toContain("redirect(privateOffer");
  });

  it("requires matching email and explicit agreement before Stripe checkout", () => {
    const action = read("src/app/offer/[token]/actions.ts");
    expect(action).toContain('.in("role", ["owner", "admin"])');
    expect(action).toContain("authorizedEmails.includes(signerEmail)");
    expect(action).toContain("!accepted || !authorityAccepted || !renewalAccepted");
    expect(action).toContain("client_reference_id: offer.salonId");
    expect(action).toContain("private_offer_key: offer.accessKey");
    expect(action).toContain("subscription_data: { metadata }");
  });

  it("does not prefill or render the private recipient email", () => {
    const page = read("src/app/offer/[token]/page.tsx");
    expect(page).not.toContain("offer.customerEmail");
    expect(page).not.toContain("defaultValue=");
  });
});
