import type { SubscriptionPlan } from "@/shared/lib/subscriptionPlans";

export const PUBLIC_TRIAL_DAYS = 14;

type StripePriceEnvKey =
  | "STRIPE_PRICE_PRO"
  | "STRIPE_PRICE_PREMIUM";

export type PublicSubscriptionPrice = {
  plan: SubscriptionPlan;
  marketingName: string;
  monthlyAmountCents: number;
  currency: "CAD";
  interval: "month";
  stripePriceEnvKey: StripePriceEnvKey | null;
};

/**
 * Canonical public subscription prices.
 *
 * These values describe the self-service plans shown by NailIQ. Private,
 * salon-specific contracts stay isolated in `shared/sales/privateOffers.ts`
 * and must never be inferred from this catalog.
 *
 * Changing an amount is a product-owner decision and also requires matching
 * Stripe Price configuration before release.
 */
export const PUBLIC_SUBSCRIPTION_PRICES = {
  free: {
    plan: "free",
    marketingName: "Free",
    monthlyAmountCents: 0,
    currency: "CAD",
    interval: "month",
    stripePriceEnvKey: null,
  },
  pro: {
    plan: "pro",
    marketingName: "Core",
    monthlyAmountCents: 3_900,
    currency: "CAD",
    interval: "month",
    stripePriceEnvKey: "STRIPE_PRICE_PRO",
  },
  premium: {
    plan: "premium",
    marketingName: "Studio",
    monthlyAmountCents: 9_900,
    currency: "CAD",
    interval: "month",
    stripePriceEnvKey: "STRIPE_PRICE_PREMIUM",
  },
} as const satisfies Record<SubscriptionPlan, PublicSubscriptionPrice>;

export function formatCadAmount(
  cents: number,
  options: { includeCurrency?: boolean } = {},
): string {
  const amount = cents / 100;
  const formatted = amount.toFixed(Number.isInteger(amount) ? 0 : 2);
  return `$${formatted}${options.includeCurrency ? " CAD" : ""}`;
}

export function formatPublicMonthlyPrice(
  plan: SubscriptionPlan,
  options: { includeCurrency?: boolean } = {},
): string {
  return formatCadAmount(
    PUBLIC_SUBSCRIPTION_PRICES[plan].monthlyAmountCents,
    options,
  );
}

export function decimalAmountFromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
