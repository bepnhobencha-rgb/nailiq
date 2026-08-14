"use server";

import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import { isOwner } from "@/shared/lib/salonMemberRole";
import {
  getStripeClient,
  getStripeReturnOrigin,
} from "@/shared/lib/stripe";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import type { SubscriptionPlan } from "@/shared/lib/subscriptionPlans";
import {
  claimStripeSubscriptionCheckout,
  finishStripeSubscriptionCheckout,
} from "@/shared/subscriptions/stripeCheckoutLedger";
import { stripeCheckoutRequestFingerprint } from "@/shared/subscriptions/stripeCheckoutFingerprint";

/**
 * Stripe-backed mutations for the salon Pricing panel.
 *
 * Permissions: owner-only per `PERMISSION_MATRIX.md` §3 (settings ↔
 * configuration row — billing decisions belong to the same row as the
 * profile-of-record changes). Senior / nail_tech are denied; the UI
 * also hides the panel for non-owners.
 *
 * Plan → price mapping reads from env vars so the same code runs in
 * dev (test prices) and prod (live prices) without conditional logic.
 * Missing price var → `invalid_plan` returned to the caller; the UI
 * surfaces a generic "could not start checkout" message.
 */

export type CreateCheckoutSessionResult =
  | { ok: true; url: string }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "forbidden"
        | "invalid_plan"
        | "no_stripe_client"
        | "server_error";
    };

export type CreateCustomerPortalSessionResult =
  | { ok: true; url: string }
  | {
      ok: false;
      error:
        | "unauthorized"
        | "forbidden"
        | "no_customer"
        | "no_stripe_client"
        | "server_error";
    };

type CheckoutPlan = Exclude<SubscriptionPlan, "free">;

function priceIdForPlan(plan: CheckoutPlan): string | null {
  const v =
    plan === "pro"
      ? process.env.STRIPE_PRICE_PRO
      : process.env.STRIPE_PRICE_PREMIUM;
  return v && v.trim().length > 0 ? v.trim() : null;
}

export async function createCheckoutSession(
  slug: string,
  plan: CheckoutPlan,
): Promise<CreateCheckoutSessionResult> {
  if (plan !== "pro" && plan !== "premium") {
    return { ok: false, error: "invalid_plan" };
  }

  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };
  if (!isOwner(resolved.role)) return { ok: false, error: "forbidden" };

  const priceId = priceIdForPlan(plan);
  if (!priceId) return { ok: false, error: "invalid_plan" };

  const stripe = getStripeClient();
  if (!stripe) return { ok: false, error: "no_stripe_client" };

  const origin = getStripeReturnOrigin();
  const slugEnc = encodeURIComponent(slug);
  // A Stripe Price is the immutable catalogue identity for its amount,
  // currency, and recurring interval. Rotating any term requires a new id and
  // therefore a new fingerprint; no live catalogue read is needed here.
  const catalogTermIdentity = { source: "stripe_price", priceId } as const;
  const requestFingerprint = stripeCheckoutRequestFingerprint({
    kind: "dashboard_subscription",
    salonId: resolved.salon.id,
    plan,
    amount: catalogTermIdentity,
    currency: catalogTermIdentity,
    interval: catalogTermIdentity,
    offerIdentity: priceId,
    successUrl: `${origin}/dashboard/${slugEnc}/settings?upgraded=1`,
    cancelUrl: `${origin}/dashboard/${slugEnc}/settings`,
  });
  const claimNow = new Date();
  let claim;
  try {
    claim = await claimStripeSubscriptionCheckout({
      salonId: resolved.salon.id,
      plan,
      requestFingerprint,
      now: claimNow,
    });
  } catch {
    console.error("[createCheckoutSession] checkout claim failed");
    return { ok: false, error: "server_error" };
  }

  if (claim.outcome === "reuse" && claim.checkoutUrl) {
    return { ok: true, url: claim.checkoutUrl };
  }
  if (
    claim.outcome !== "acquired" ||
    !claim.idempotencyKey ||
    !claim.leaseToken
  ) {
    // An existing subscription, another plan, or an in-flight request must
    // never fall through to a second Stripe Checkout creation.
    return { ok: false, error: "server_error" };
  }

  const releaseClaimForRetry = async (errorCode: string) => {
    try {
      await finishStripeSubscriptionCheckout({
        salonId: resolved.salon.id,
        leaseToken: claim.leaseToken!,
        outcome: "retryable_failure",
        errorCode,
        now: new Date(),
      });
    } catch {
      // Fail closed. The short database lease will expire, and the next call
      // will retry with the same provider idempotency key.
      console.error("[createCheckoutSession] checkout claim release failed");
    }
  };

  // Get-or-create the Stripe customer. If the salon row already has a
  // customer id we reuse it (cheaper, keeps dashboard / charges
  // history continuous); otherwise create one tagged with the salon
  // id so the webhook can dispatch back here.
  const supabase = createServiceRoleClient();
  const { data: salonRow, error: rowErr } = await supabase
    .from("salons")
    .select("id, name, slug, email, stripe_customer_id")
    .eq("id", resolved.salon.id)
    .maybeSingle();

  if (rowErr) {
    console.error("[createCheckoutSession] salons row", rowErr);
    await releaseClaimForRetry("salon_lookup_failed");
    return { ok: false, error: "server_error" };
  }

  type SalonStripeRow = {
    id: string;
    name: string | null;
    slug: string | null;
    email: string | null;
    stripe_customer_id: string | null;
  };
  const r = (salonRow ?? null) as SalonStripeRow | null;
  if (!r?.id) {
    await releaseClaimForRetry("salon_lookup_failed");
    return { ok: false, error: "server_error" };
  }

  let customerId = r.stripe_customer_id?.trim() ?? "";
  if (!customerId) {
    try {
      const customer = await stripe.customers.create(
        {
          email: r.email ?? undefined,
          name: r.name ?? r.slug ?? undefined,
          metadata: { salon_id: r.id, salon_slug: String(r.slug ?? "") },
        },
        { idempotencyKey: `${claim.idempotencyKey}:customer` },
      );
      customerId = customer.id;
      // Persist before creating Checkout. A retry uses the same Stripe key and
      // receives this same customer if the first response was interrupted.
      const { error: updErr } = await supabase
        .from("salons")
        .update({ stripe_customer_id: customerId })
        .eq("id", r.id);
      if (updErr) {
        console.error("[createCheckoutSession] persist customer", updErr);
        await releaseClaimForRetry("customer_persist_failed");
        return { ok: false, error: "server_error" };
      }
    } catch (e) {
      console.error("[createCheckoutSession] customers.create", e);
      await releaseClaimForRetry("customer_create_failed");
      return { ok: false, error: "server_error" };
    }
  }

  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${origin}/dashboard/${slugEnc}/settings?upgraded=1`,
        cancel_url: `${origin}/dashboard/${slugEnc}/settings`,
        // Surface the salon id on the checkout session AND the resulting
        // subscription so the webhook can dispatch even if the customer
        // mapping somehow drifted.
        client_reference_id: r.id,
        subscription_data: {
          metadata: { salon_id: r.id, plan },
        },
        metadata: { salon_id: r.id, plan },
      },
      { idempotencyKey: `${claim.idempotencyKey}:session` },
    );
    if (!session.url) {
      console.error("[createCheckoutSession] no url");
      await releaseClaimForRetry("checkout_url_missing");
      return { ok: false, error: "server_error" };
    }

    const expiresAt =
      typeof session.expires_at === "number" &&
      Number.isFinite(session.expires_at) &&
      session.expires_at > 0
        ? new Date(session.expires_at * 1000).toISOString()
        : claim.expiresAt;
    if (!expiresAt || new Date(expiresAt).getTime() <= Date.now()) {
      console.error("[createCheckoutSession] invalid expiry");
      await releaseClaimForRetry("checkout_expiry_invalid");
      return { ok: false, error: "server_error" };
    }

    const finished = await finishStripeSubscriptionCheckout({
      salonId: resolved.salon.id,
      leaseToken: claim.leaseToken,
      outcome: "open",
      checkoutSessionId: session.id,
      checkoutUrl: session.url,
      expiresAt,
      now: new Date(),
    });
    if (!finished) {
      console.error("[createCheckoutSession] stale checkout claim");
      return { ok: false, error: "server_error" };
    }
    return { ok: true, url: session.url };
  } catch (e) {
    console.error("[createCheckoutSession] checkout.sessions.create", e);
    await releaseClaimForRetry("checkout_create_failed");
    return { ok: false, error: "server_error" };
  }
}

export async function createCustomerPortalSession(
  slug: string,
): Promise<CreateCustomerPortalSessionResult> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };
  if (!isOwner(resolved.role)) return { ok: false, error: "forbidden" };

  const stripe = getStripeClient();
  if (!stripe) return { ok: false, error: "no_stripe_client" };

  const supabase = createServiceRoleClient();
  const { data: salonRow, error: rowErr } = await supabase
    .from("salons")
    .select("stripe_customer_id")
    .eq("id", resolved.salon.id)
    .maybeSingle();

  if (rowErr) {
    console.error("[createCustomerPortalSession] salons row", rowErr);
    return { ok: false, error: "server_error" };
  }

  const customerId =
    typeof (salonRow as { stripe_customer_id?: string | null } | null)
      ?.stripe_customer_id === "string"
      ? String(
          (salonRow as { stripe_customer_id: string | null })
            .stripe_customer_id ?? "",
        ).trim()
      : "";

  if (!customerId) return { ok: false, error: "no_customer" };

  const origin = getStripeReturnOrigin();
  const slugEnc = encodeURIComponent(slug);
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${origin}/dashboard/${slugEnc}/settings`,
    });
    return { ok: true, url: session.url };
  } catch (e) {
    console.error("[createCustomerPortalSession] portal.create", e);
    return { ok: false, error: "server_error" };
  }
}
