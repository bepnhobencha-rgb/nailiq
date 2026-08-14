import "server-only";

import type { SubscriptionPlan } from "@/shared/lib/subscriptionPlans";

export type PrivateOffer = {
  accessKey: string;
  salonId: string;
  salonName: string;
  salonSlug: string;
  monthlyAmountCents: number;
  monthlySetupAmountCents: number;
  quarterlyAmountCents?: number;
  semiannualAmountCents?: number;
  annualAmountCents: number;
  plan: Exclude<SubscriptionPlan, "free">;
  agreementVersion: string;
};

export type PrivateOfferBillingSchedule =
  "monthly" | "quarterly" | "semiannual" | "annual";

export type PrivateOfferBillingTerm = {
  schedule: PrivateOfferBillingSchedule;
  amountCents: number;
  currency: "usd";
  interval: "month" | "year";
  intervalCount: number;
  setupFeeAmountCents: number;
};

const AGREEMENT_VERSION = "hilite-founder-offer-2026-07-29-ca-b2b-v3";

const PRIVATE_OFFERS: readonly PrivateOffer[] = [
  {
    accessKey: process.env.OFFER_TOKEN_HILITE_HEAD_SPA?.trim() ?? "",
    salonId: "d06ca42b-d9db-4d02-9d4c-716a1e8c94be",
    salonName: "Hi-Lite Head Spa",
    salonSlug: "hilite-anaheim",
    monthlyAmountCents: 19_900,
    monthlySetupAmountCents: 29_900,
    annualAmountCents: 199_000,
    plan: "premium",
    agreementVersion: AGREEMENT_VERSION,
  },
  {
    accessKey: process.env.OFFER_TOKEN_HILITE_STUDIO?.trim() ?? "",
    salonId: "a7de260d-999e-4462-a11e-2297aa615012",
    salonName: "Hi-Lite Studio",
    salonSlug: "hilite-studio",
    monthlyAmountCents: 14_900,
    monthlySetupAmountCents: 29_900,
    quarterlyAmountCents: 44_700,
    semiannualAmountCents: 89_400,
    annualAmountCents: 149_000,
    plan: "pro",
    agreementVersion: AGREEMENT_VERSION,
  },
] as const;

export function getPrivateOffer(token: string): PrivateOffer | null {
  const normalized = token.trim().toLowerCase();
  if (!normalized) return null;
  return (
    PRIVATE_OFFERS.find(
      (offer) => offer.accessKey && offer.accessKey === normalized,
    ) ?? null
  );
}

export function getPrivateOfferBySalonId(salonId: string): PrivateOffer | null {
  // Webhook reconciliation must remain possible if the capability URL token is
  // rotated or disabled after Checkout. Pricing truth is the server catalogue,
  // not continued availability of the offer link.
  return PRIVATE_OFFERS.find((offer) => offer.salonId === salonId) ?? null;
}

/**
 * Stable, non-secret identity copied to Stripe subscription metadata.
 *
 * The access token remains a capability URL and must not be copied to Stripe
 * Product metadata. This identity is safe to persist and is re-derived from
 * the trusted server-side offer catalogue by the webhook.
 */
export function privateOfferIdentity(offer: PrivateOffer): string {
  return `founder:${offer.salonId}:${offer.agreementVersion}`;
}

export function resolvePrivateOfferBillingTerm(
  offer: PrivateOffer,
  schedule: string | null | undefined,
): PrivateOfferBillingTerm | null {
  if (schedule === "monthly") {
    return {
      schedule,
      amountCents: offer.monthlyAmountCents,
      currency: "usd",
      interval: "month",
      intervalCount: 1,
      setupFeeAmountCents: offer.monthlySetupAmountCents,
    };
  }
  if (schedule === "quarterly" && offer.quarterlyAmountCents) {
    return {
      schedule,
      amountCents: offer.quarterlyAmountCents,
      currency: "usd",
      interval: "month",
      intervalCount: 3,
      setupFeeAmountCents: 0,
    };
  }
  if (schedule === "semiannual" && offer.semiannualAmountCents) {
    return {
      schedule,
      amountCents: offer.semiannualAmountCents,
      currency: "usd",
      interval: "month",
      intervalCount: 6,
      setupFeeAmountCents: 0,
    };
  }
  if (schedule === "annual") {
    return {
      schedule,
      amountCents: offer.annualAmountCents,
      currency: "usd",
      interval: "year",
      intervalCount: 1,
      setupFeeAmountCents: 0,
    };
  }
  return null;
}

export function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}
