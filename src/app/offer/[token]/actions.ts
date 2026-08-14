"use server";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";

import { getStripeClient, getStripeReturnOrigin } from "@/shared/lib/stripe";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  getPrivateOffer,
  privateOfferIdentity,
  resolvePrivateOfferBillingTerm,
} from "@/shared/sales/privateOffers";
import { reconcileExpiredStripeCheckout } from "@/shared/subscriptions/stripeCheckoutReconciliation";
import { stripeCheckoutRequestFingerprint } from "@/shared/subscriptions/stripeCheckoutFingerprint";
import {
  claimStripeSubscriptionCheckout,
  finishStripeSubscriptionCheckout,
  type StripeCheckoutClaim,
} from "@/shared/subscriptions/stripeCheckoutLedger";
import { persistStripeCustomerBinding } from "@/shared/subscriptions/stripeCustomerBinding";

function fail(token: string, code: string): never {
  redirect(
    `/offer/${encodeURIComponent(token)}?error=${encodeURIComponent(code)}`,
  );
}

export async function startPrivateOfferCheckout(
  token: string,
  formData: FormData,
): Promise<never> {
  const offer = getPrivateOffer(token);
  if (!offer) redirect("/");

  const signerName = String(formData.get("signerName") ?? "").trim();
  const signerTitle = String(formData.get("signerTitle") ?? "").trim();
  const businessLegalName = String(
    formData.get("businessLegalName") ?? "",
  ).trim();
  const signerEmail = String(formData.get("signerEmail") ?? "")
    .trim()
    .toLowerCase();
  const accepted = formData.get("agreementAccepted") === "yes";
  const authorityAccepted = formData.get("authorityAccepted") === "yes";
  const renewalAccepted = formData.get("renewalAccepted") === "yes";
  const billing = resolvePrivateOfferBillingTerm(
    offer,
    String(formData.get("billingSchedule") ?? ""),
  );

  if (signerName.length < 2 || signerName.length > 120) fail(token, "signer");
  if (signerTitle.length < 2 || signerTitle.length > 100) fail(token, "title");
  if (businessLegalName.length < 2 || businessLegalName.length > 160)
    fail(token, "business");
  if (!accepted || !authorityAccepted || !renewalAccepted)
    fail(token, "agreement");
  if (!billing) fail(token, "billing");

  const stripe = getStripeClient();
  if (!stripe) fail(token, "stripe");
  const db = createServiceRoleClient();
  const { data: salon, error } = await db
    .from("salons")
    .select("id,name,slug,stripe_customer_id,stripe_subscription_id")
    .eq("id", offer.salonId)
    .maybeSingle();
  if (error || !salon || salon.slug !== offer.salonSlug) fail(token, "salon");
  if (salon.stripe_subscription_id) fail(token, "already-active");

  // Resolve authorized recipients at request time instead of committing owner
  // email addresses to source control. The error remains deliberately generic
  // so this endpoint cannot be used to enumerate salon administrators.
  const { data: members, error: memberError } = await db
    .from("salon_members")
    .select("user_id,role")
    .eq("salon_id", offer.salonId)
    .in("role", ["owner", "admin"]);
  if (memberError || !members?.length) fail(token, "email");
  const adminUsers = await Promise.all(
    members.map((member) => db.auth.admin.getUserById(member.user_id)),
  );
  const authorizedEmails = adminUsers
    .map(({ data }) => data.user?.email?.trim().toLowerCase())
    .filter((email): email is string => Boolean(email));
  if (!authorizedEmails.includes(signerEmail)) fail(token, "email");

  const requestHeaders = await headers();
  const acceptanceIp = (
    requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    requestHeaders.get("x-real-ip") ??
    "unknown"
  ).slice(0, 100);
  const origin = getStripeReturnOrigin();
  const successUrl = `${origin}/offer/${offer.accessKey}/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin}/offer/${offer.accessKey}?checkout=cancelled`;
  const setupFeeAmountCents = billing.setupFeeAmountCents;
  const offerIdentity = privateOfferIdentity(offer);
  const requestFingerprint = stripeCheckoutRequestFingerprint({
    kind: "private_offer_subscription",
    salonId: offer.salonId,
    salonSlug: offer.salonSlug,
    plan: offer.plan,
    amountCents: billing.amountCents,
    currency: billing.currency,
    interval: billing.interval,
    intervalCount: billing.intervalCount,
    setupFeeAmountCents,
    billingSchedule: billing.schedule,
    offerIdentity,
    agreementVersion: offer.agreementVersion,
    customerName: salon.name ?? offer.salonName,
    signerName,
    signerTitle,
    signerEmail,
    businessLegalName,
    acceptanceIp,
    successUrl,
    cancelUrl,
  });

  let claim: StripeCheckoutClaim;
  try {
    claim = await claimStripeSubscriptionCheckout({
      salonId: offer.salonId,
      plan: offer.plan,
      requestFingerprint,
      now: new Date(),
    });
  } catch (claimError) {
    console.error("[private offer] checkout claim failed", claimError);
    fail(token, "stripe");
  }

  if (claim.outcome === "active_subscription") fail(token, "already-active");
  if (claim.outcome === "reuse" && claim.checkoutUrl) {
    redirect(claim.checkoutUrl);
  }
  if (claim.outcome === "reconcile") {
    let reconciled;
    try {
      reconciled = await reconcileExpiredStripeCheckout({
        stripe,
        salonId: offer.salonId,
        expectedCustomerId: salon.stripe_customer_id?.trim() ?? "",
        claim,
        now: new Date(),
      });
    } catch (reconcileError) {
      console.error(
        "[private offer] provider reconciliation failed",
        reconcileError,
      );
      fail(token, "stripe");
    }
    if (reconciled.outcome === "reuse") redirect(reconciled.url);
    if (reconciled.outcome === "blocked") fail(token, "already-active");
    if (reconciled.outcome !== "closed") fail(token, "stripe");
    try {
      claim = await claimStripeSubscriptionCheckout({
        salonId: offer.salonId,
        plan: offer.plan,
        requestFingerprint,
        now: new Date(),
      });
    } catch {
      fail(token, "stripe");
    }
  }
  if (
    claim.outcome !== "acquired" ||
    !claim.idempotencyKey ||
    !claim.leaseToken ||
    !claim.requestedAt
  ) {
    fail(token, "stripe");
  }

  const releaseClaimForRetry = async (errorCode: string) => {
    try {
      await finishStripeSubscriptionCheckout({
        salonId: offer.salonId,
        leaseToken: claim.leaseToken!,
        outcome: "retryable_failure",
        errorCode,
        now: new Date(),
      });
    } catch {
      // The short lease expires safely; a later identical request keeps the
      // same Stripe key and a changed request remains blocked by its digest.
      console.error("[private offer] checkout claim release failed");
    }
  };

  try {
    let customerId = salon.stripe_customer_id?.trim() ?? "";
    if (!customerId) {
      const customer = await stripe.customers.create(
        {
          email: signerEmail,
          name: salon.name ?? offer.salonName,
          metadata: { salon_id: offer.salonId, salon_slug: offer.salonSlug },
        },
        { idempotencyKey: `${claim.idempotencyKey}:customer` },
      );
      customerId = customer.id;
      await persistStripeCustomerBinding({
        salonId: offer.salonId,
        stripeCustomerId: customerId,
      });
    }

    // The reservation timestamp is stable across a network retry, keeping the
    // legal metadata and Stripe request parameters byte-for-byte consistent.
    const acceptedAt = claim.requestedAt;
    const metadata = {
      salon_id: offer.salonId,
      salon_slug: offer.salonSlug,
      plan: offer.plan,
      pricing_source: "private_offer",
      private_offer_identity: offerIdentity,
      agreement_version: offer.agreementVersion,
      agreement_accepted_at: acceptedAt,
      authorized_signer: signerName,
      authorized_signer_title: signerTitle,
      authorized_signer_email: signerEmail,
      business_legal_name: businessLegalName,
      authority_confirmed: "true",
      automatic_renewal_confirmed: "true",
      acceptance_ip: acceptanceIp,
      initial_term_months: "12",
      billing_schedule: billing.schedule,
      recurring_amount_cents: String(billing.amountCents),
      billing_currency: billing.currency,
      billing_interval: billing.interval,
      billing_interval_count: String(billing.intervalCount),
      setup_fee_cents: String(setupFeeAmountCents),
    };
    const recurringLineItem = {
      quantity: 1,
      price_data: {
        currency: billing.currency,
        unit_amount: billing.amountCents,
        recurring: {
          interval: billing.interval,
          interval_count: billing.intervalCount,
        },
        product_data: {
          name: `NailIQ Managed Salon — ${offer.salonName}`,
          metadata: {
            pricing_source: "private_offer",
            salon_id: offer.salonId,
            plan: offer.plan,
            private_offer_identity: offerIdentity,
            billing_schedule: billing.schedule,
          },
        },
      },
    };
    const setupLineItem = {
      quantity: 1,
      price_data: {
        currency: billing.currency,
        unit_amount: billing.setupFeeAmountCents,
        product_data: {
          name: `NailIQ one-time setup — ${offer.salonName}`,
          metadata: {
            pricing_source: "private_offer_setup",
            salon_id: offer.salonId,
            private_offer_identity: offerIdentity,
          },
        },
      },
    };
    const lineItems =
      billing.setupFeeAmountCents > 0
        ? [recurringLineItem, setupLineItem]
        : [recurringLineItem];
    const session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: customerId,
        billing_address_collection: "required",
        client_reference_id: offer.salonId,
        line_items: lineItems,
        metadata,
        subscription_data: { metadata },
        success_url: successUrl,
        cancel_url: cancelUrl,
      },
      { idempotencyKey: `${claim.idempotencyKey}:session` },
    );
    if (!session.url) throw new Error("private_offer_checkout_url_missing");

    const expiresAt =
      typeof session.expires_at === "number" &&
      Number.isFinite(session.expires_at) &&
      session.expires_at > 0
        ? new Date(session.expires_at * 1000).toISOString()
        : claim.expiresAt;
    if (!expiresAt || new Date(expiresAt).getTime() <= Date.now()) {
      throw new Error("private_offer_checkout_expiry_invalid");
    }

    const finished = await finishStripeSubscriptionCheckout({
      salonId: offer.salonId,
      leaseToken: claim.leaseToken,
      outcome: "open",
      checkoutSessionId: session.id,
      checkoutUrl: session.url,
      expiresAt,
      now: new Date(),
    });
    if (!finished) throw new Error("private_offer_checkout_stale_claim");
    redirect(session.url);
  } catch (checkoutError) {
    unstable_rethrow(checkoutError);
    console.error("[private offer] checkout creation failed", checkoutError);
    await releaseClaimForRetry("checkout_create_failed");
    fail(token, "stripe");
  }
}
