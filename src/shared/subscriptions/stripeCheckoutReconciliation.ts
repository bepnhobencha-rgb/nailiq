import "server-only";

import type Stripe from "stripe";

import type { StripeCheckoutClaim } from "@/shared/subscriptions/stripeCheckoutLedger";
import { reconcileStripeSubscriptionCheckout } from "@/shared/subscriptions/stripeCheckoutLedger";

export type StripeCheckoutReconciliationResult =
  | { outcome: "reuse"; url: string }
  | { outcome: "closed" }
  | { outcome: "blocked" }
  | { outcome: "failed" };

function objectId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return null;
}

function providerCompletionStatus(
  paymentStatus: Stripe.Checkout.Session["payment_status"] | null | undefined,
): "payment_pending" | "payment_succeeded" {
  return paymentStatus === "paid" || paymentStatus === "no_payment_required"
    ? "payment_succeeded"
    : "payment_pending";
}

export async function reconcileExpiredStripeCheckout(input: {
  stripe: Stripe;
  salonId: string;
  expectedCustomerId: string;
  claim: StripeCheckoutClaim;
  now: Date;
}): Promise<StripeCheckoutReconciliationResult> {
  const { claim } = input;
  if (
    claim.outcome !== "reconcile" ||
    !claim.leaseToken ||
    !claim.checkoutSessionId
  ) {
    throw new Error("stripe_checkout_reconcile_claim_invalid");
  }

  const finishFailure =
    async (): Promise<StripeCheckoutReconciliationResult> => {
      const finished = await reconcileStripeSubscriptionCheckout({
        salonId: input.salonId,
        leaseToken: claim.leaseToken!,
        outcome: "retryable_failure",
        now: input.now,
      });
      if (!finished) throw new Error("stripe_checkout_reconcile_stale_lease");
      return { outcome: "failed" };
    };

  let session: Stripe.Checkout.Session;
  try {
    session = await input.stripe.checkout.sessions.retrieve(
      claim.checkoutSessionId,
    );
  } catch {
    return finishFailure();
  }

  const customerId = objectId(session.customer);
  const subscriptionId = objectId(session.subscription);
  if (
    session.id !== claim.checkoutSessionId ||
    session.client_reference_id !== input.salonId ||
    !input.expectedCustomerId ||
    customerId !== input.expectedCustomerId
  ) {
    return finishFailure();
  }

  if (session.status === "open") {
    const expiresAt =
      typeof session.expires_at === "number" &&
      Number.isFinite(session.expires_at) &&
      session.expires_at > 0
        ? new Date(session.expires_at * 1000).toISOString()
        : null;
    if (
      !session.url ||
      !expiresAt ||
      new Date(expiresAt).getTime() <= input.now.getTime()
    ) {
      return finishFailure();
    }
    const finished = await reconcileStripeSubscriptionCheckout({
      salonId: input.salonId,
      leaseToken: claim.leaseToken,
      outcome: "open",
      checkoutUrl: session.url,
      providerStatus: "open",
      expiresAt,
      now: input.now,
    });
    if (!finished) throw new Error("stripe_checkout_reconcile_stale_lease");
    return { outcome: "reuse", url: session.url };
  }

  if (session.status === "complete" || subscriptionId) {
    if (!subscriptionId) return finishFailure();
    const finished = await reconcileStripeSubscriptionCheckout({
      salonId: input.salonId,
      leaseToken: claim.leaseToken,
      outcome: "completed",
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      providerStatus: providerCompletionStatus(session.payment_status),
      now: input.now,
    });
    if (!finished) throw new Error("stripe_checkout_reconcile_stale_lease");
    return { outcome: "blocked" };
  }

  if (session.status === "expired") {
    const finished = await reconcileStripeSubscriptionCheckout({
      salonId: input.salonId,
      leaseToken: claim.leaseToken,
      outcome: "closed",
      providerStatus: "checkout_expired",
      now: input.now,
    });
    if (!finished) throw new Error("stripe_checkout_reconcile_stale_lease");
    return { outcome: "closed" };
  }

  return finishFailure();
}
