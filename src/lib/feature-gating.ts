import type { Json } from "@/lib/database.types";

export type SubscriptionPlan = "free" | "pro" | "premium" | "enterprise";

/** Features gated by plan. Map plan → set of feature keys it includes. */
const PLAN_FEATURES: Record<string, readonly string[]> = {
  free: [],
  pro: [
    "photo_confirmation",
    "ai_smart_upsell",
    "quick_rebook",
    "reviews",
  ],
  premium: [
    "photo_confirmation",
    "ai_smart_upsell",
    "quick_rebook",
    "reviews",
    "birthday_voucher",
    "welcome_back_voucher",
    "bring_a_friend",
    "ai_trend_suggestions",
  ],
  enterprise: [
    "photo_confirmation",
    "ai_smart_upsell",
    "quick_rebook",
    "reviews",
    "birthday_voucher",
    "welcome_back_voucher",
    "bring_a_friend",
    "ai_trend_suggestions",
    "ai_chatbot",
  ],
};

type SalonForGating = {
  subscription_plan: string;
  plan_override: string | null;
  feature_flags: Json;
};

/**
 * Resolves feature access for a salon.
 * Priority: feature_flags JSONB override → plan_override → subscription_plan.
 */
export function hasFeature(salon: SalonForGating, feature: string): boolean {
  const flags = salon.feature_flags as Record<string, boolean> | null;
  if (flags && typeof flags[feature] === "boolean") {
    return flags[feature];
  }
  const plan = salon.plan_override ?? salon.subscription_plan;
  return PLAN_FEATURES[plan]?.includes(feature) ?? false;
}

/** All feature keys for the given plan (used for UI listings). */
export function planFeatures(plan: SubscriptionPlan): readonly string[] {
  return PLAN_FEATURES[plan] ?? [];
}
