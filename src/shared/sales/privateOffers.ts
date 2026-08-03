import "server-only";

import type { SubscriptionPlan } from "@/shared/lib/subscriptionPlans";

export type PrivateOffer = {
  accessKey: string;
  salonId: string;
  salonName: string;
  salonSlug: string;
  monthlyAmountCents: number;
  annualAmountCents: number;
  plan: Exclude<SubscriptionPlan, "free">;
  agreementVersion: string;
};

const AGREEMENT_VERSION = "hilite-founder-offer-2026-07-29-ca-b2b-v3";

const PRIVATE_OFFERS: readonly PrivateOffer[] = [
  {
    accessKey: process.env.OFFER_TOKEN_HILITE_HEAD_SPA?.trim() ?? "",
    salonId: "d06ca42b-d9db-4d02-9d4c-716a1e8c94be",
    salonName: "Hi-Lite Head Spa",
    salonSlug: "hilite-anaheim",
    monthlyAmountCents: 19_900,
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
    annualAmountCents: 149_000,
    plan: "pro",
    agreementVersion: AGREEMENT_VERSION,
  },
] as const;

export function getPrivateOffer(token: string): PrivateOffer | null {
  const normalized = token.trim().toLowerCase();
  if (!normalized) return null;
  return PRIVATE_OFFERS.find((offer) => offer.accessKey && offer.accessKey === normalized) ?? null;
}

export function getPrivateOfferBySalonId(salonId: string): PrivateOffer | null {
  return PRIVATE_OFFERS.find((offer) => offer.accessKey && offer.salonId === salonId) ?? null;
}

export function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}
