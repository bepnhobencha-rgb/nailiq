"use server";

import { resolveSalonForDashboard } from "@/shared/dashboard/salonOwnerActions";
import {
  getStripeClient,
  getStripeReturnOrigin,
} from "@/shared/lib/stripe";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import type { SubscriptionPlan } from "@/shared/lib/subscriptionPlans";

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
  if (resolved.role !== "owner") return { ok: false, error: "forbidden" };

  const priceId = priceIdForPlan(plan);
  if (!priceId) return { ok: false, error: "invalid_plan" };

  const stripe = getStripeClient();
  if (!stripe) return { ok: false, error: "no_stripe_client" };

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
  if (!r?.id) return { ok: false, error: "server_error" };

  let customerId = r.stripe_customer_id?.trim() ?? "";
  if (!customerId) {
    try {
      const customer = await stripe.customers.create({
        email: r.email ?? undefined,
        name: r.name ?? r.slug ?? undefined,
        metadata: { salon_id: r.id, salon_slug: String(r.slug ?? "") },
      });
      customerId = customer.id;
      // Persist immediately so a re-tap before checkout completion
      // doesn't create a second customer.
      const { error: updErr } = await supabase
        .from("salons")
        .update({ stripe_customer_id: customerId })
        .eq("id", r.id);
      if (updErr) {
        console.error("[createCheckoutSession] persist customer", updErr);
        // Non-fatal — checkout can still proceed; the webhook will
        // back-fill on completion.
      }
    } catch (e) {
      console.error("[createCheckoutSession] customers.create", e);
      return { ok: false, error: "server_error" };
    }
  }

  const origin = getStripeReturnOrigin();
  const slugEnc = encodeURIComponent(slug);
  try {
    const session = await stripe.checkout.sessions.create({
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
    });
    if (!session.url) {
      console.error("[createCheckoutSession] no url");
      return { ok: false, error: "server_error" };
    }
    return { ok: true, url: session.url };
  } catch (e) {
    console.error("[createCheckoutSession] checkout.sessions.create", e);
    return { ok: false, error: "server_error" };
  }
}

export async function createCustomerPortalSession(
  slug: string,
): Promise<CreateCustomerPortalSessionResult> {
  const resolved = await resolveSalonForDashboard(slug);
  if (!resolved) return { ok: false, error: "unauthorized" };
  if (resolved.role !== "owner") return { ok: false, error: "forbidden" };

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
