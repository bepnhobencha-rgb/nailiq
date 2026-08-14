import "server-only";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import type { SubscriptionPlan } from "@/shared/lib/subscriptionPlans";

type CheckoutPlan = Exclude<SubscriptionPlan, "free">;

export type StripeCheckoutClaim = {
  outcome:
    | "acquired"
    | "reuse"
    | "reconcile"
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
    CheckoutClaimRow | null | undefined;
  const outcome = optionalString(row?.outcome);
  if (
    outcome !== "acquired" &&
    outcome !== "reuse" &&
    outcome !== "reconcile" &&
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

export async function reconcileStripeSubscriptionCheckout(input: {
  salonId: string;
  leaseToken: string;
  outcome: "open" | "completed" | "closed" | "retryable_failure";
  checkoutUrl?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  providerStatus?:
    | "open"
    | "payment_pending"
    | "payment_succeeded"
    | "payment_failed"
    | "checkout_expired"
    | null;
  expiresAt?: string | null;
  now: Date;
}): Promise<boolean> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "reconcile_stripe_subscription_checkout" as never,
    {
      p_salon_id: input.salonId,
      p_lease_token: input.leaseToken,
      p_outcome: input.outcome,
      p_checkout_url: input.checkoutUrl ?? null,
      p_stripe_customer_id: input.stripeCustomerId ?? null,
      p_stripe_subscription_id: input.stripeSubscriptionId ?? null,
      p_provider_status: input.providerStatus ?? null,
      p_expires_at: input.expiresAt ?? null,
      p_now: input.now.toISOString(),
    } as never,
  );
  if (error) throw new Error("stripe_checkout_reconcile_failed");
  return data === true;
}

export type StripeCheckoutCompletionResult =
  "marked" | "duplicate" | "missing" | "conflict" | "invalid";

export async function markStripeSubscriptionCheckoutCompleted(input: {
  salonId: string;
  checkoutSessionId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  providerStatus: "payment_pending" | "payment_succeeded" | "payment_failed";
  now: Date;
}): Promise<StripeCheckoutCompletionResult> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "mark_stripe_subscription_checkout_completed" as never,
    {
      p_salon_id: input.salonId,
      p_checkout_session_id: input.checkoutSessionId,
      p_stripe_customer_id: input.stripeCustomerId,
      p_stripe_subscription_id: input.stripeSubscriptionId,
      p_provider_status: input.providerStatus,
      p_now: input.now.toISOString(),
    } as never,
  );
  if (error) throw new Error("stripe_checkout_completion_failed");
  if (
    data !== "marked" &&
    data !== "duplicate" &&
    data !== "missing" &&
    data !== "conflict" &&
    data !== "invalid"
  ) {
    throw new Error("stripe_checkout_completion_invalid");
  }
  return data;
}

export async function closeStripeSubscriptionCheckout(input: {
  salonId: string;
  stripeSubscriptionId: string;
  now: Date;
}): Promise<boolean> {
  const db = createServiceRoleClient();
  const { data, error } = await db.rpc(
    "close_stripe_subscription_checkout" as never,
    {
      p_salon_id: input.salonId,
      p_stripe_subscription_id: input.stripeSubscriptionId,
      p_provider_status: "subscription_terminal",
      p_now: input.now.toISOString(),
    } as never,
  );
  if (error) throw new Error("stripe_checkout_close_failed");
  return data === true;
}
