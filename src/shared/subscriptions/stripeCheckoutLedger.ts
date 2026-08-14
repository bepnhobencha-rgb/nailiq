import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import type { SubscriptionPlan } from "@/shared/lib/subscriptionPlans";

type CheckoutPlan = Exclude<SubscriptionPlan, "free">;

export type StripeCheckoutClaim = {
  outcome:
    | "acquired"
    | "reuse"
    | "pending"
    | "conflicting_plan"
    | "conflicting_request"
    | "active_subscription"
    | "invalid_plan"
    | "invalid_request"
    | "missing_salon";
  idempotencyKey: string | null;
  checkoutUrl: string | null;
  leaseToken: string | null;
  reservedPlan: CheckoutPlan | null;
  checkoutSessionId: string | null;
  expiresAt: string | null;
  requestedAt: string | null;
};

type CheckoutClaimRow = {
  outcome?: unknown;
  idempotency_key?: unknown;
  checkout_url?: unknown;
  lease_token?: unknown;
  reserved_plan?: unknown;
  checkout_session_id?: unknown;
  expires_at?: unknown;
  requested_at?: unknown;
};

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function parseClaimRow(value: unknown): StripeCheckoutClaim {
  const row = (Array.isArray(value) ? value[0] : value) as
    | CheckoutClaimRow
    | null
    | undefined;
  const outcome = optionalString(row?.outcome);
  if (
    outcome !== "acquired" &&
    outcome !== "reuse" &&
    outcome !== "pending" &&
    outcome !== "conflicting_plan" &&
    outcome !== "conflicting_request" &&
    outcome !== "active_subscription" &&
    outcome !== "invalid_plan" &&
    outcome !== "invalid_request" &&
    outcome !== "missing_salon"
  ) {
    throw new Error("stripe_checkout_claim_invalid");
  }

  const reservedPlan = optionalString(row?.reserved_plan);
  return {
    outcome,
    idempotencyKey: optionalString(row?.idempotency_key),
    checkoutUrl: optionalString(row?.checkout_url),
    leaseToken: optionalString(row?.lease_token),
    reservedPlan:
      reservedPlan === "pro" || reservedPlan === "premium"
        ? reservedPlan
        : null,
    checkoutSessionId: optionalString(row?.checkout_session_id),
    expiresAt: optionalString(row?.expires_at),
    requestedAt: optionalString(row?.requested_at),
  };
}

export async function claimStripeSubscriptionCheckout(input: {
  salonId: string;
  plan: CheckoutPlan;
  requestFingerprint: string;
  now: Date;
}): Promise<StripeCheckoutClaim> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "claim_stripe_subscription_checkout" as never,
    {
      p_salon_id: input.salonId,
      p_plan: input.plan,
      p_request_fingerprint: input.requestFingerprint,
      p_now: input.now.toISOString(),
    } as never,
  );
  if (error) throw new Error("stripe_checkout_claim_failed");
  return parseClaimRow(data);
}

export async function finishStripeSubscriptionCheckout(input: {
  salonId: string;
  leaseToken: string;
  outcome: "open" | "retryable_failure";
  checkoutSessionId?: string | null;
  checkoutUrl?: string | null;
  expiresAt?: string | null;
  errorCode?: string | null;
  now: Date;
}): Promise<boolean> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "finish_stripe_subscription_checkout" as never,
    {
      p_salon_id: input.salonId,
      p_lease_token: input.leaseToken,
      p_outcome: input.outcome,
      p_checkout_session_id: input.checkoutSessionId ?? null,
      p_checkout_url: input.checkoutUrl ?? null,
      p_expires_at: input.expiresAt ?? null,
      p_error_code: input.errorCode ?? null,
      p_now: input.now.toISOString(),
    } as never,
  );
  if (error) throw new Error("stripe_checkout_finish_failed");
  return data === true;
}
