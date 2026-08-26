"use server";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";

import { getStripeClient, getStripeReturnOrigin } from "@/shared/lib/stripe";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { v1AllowsAutomatedSubscriptionBilling } from "@/shared/release/v1IntegrationScope";
import { getPrivateOffer } from "@/shared/sales/privateOffers";

type BillingSchedule = "monthly" | "quarterly" | "semiannual" | "annual";

function resolveBillingSchedule(
  offer: NonNullable<ReturnType<typeof getPrivateOffer>>,
  value: FormDataEntryValue | null,
): { schedule: BillingSchedule; amount: number; interval: "month" | "year"; intervalCount?: number } | null {
  if (value === "monthly") {
    return { schedule: "monthly", amount: offer.monthlyAmountCents, interval: "month" };
  }
  if (value === "quarterly" && offer.quarterlyAmountCents) {
    return { schedule: "quarterly", amount: offer.quarterlyAmountCents, interval: "month", intervalCount: 3 };
  }
  if (value === "semiannual" && offer.semiannualAmountCents) {
    return { schedule: "semiannual", amount: offer.semiannualAmountCents, interval: "month", intervalCount: 6 };
  }
  if (value === "annual") {
    return { schedule: "annual", amount: offer.annualAmountCents, interval: "year" };
  }
  return null;
}

function fail(token: string, code: string): never {
  redirect(`/offer/${encodeURIComponent(token)}?error=${encodeURIComponent(code)}`);
}

export async function startPrivateOfferCheckout(token: string, formData: FormData): Promise<never> {
  const offer = getPrivateOffer(token);
  if (!offer) redirect("/");
  if (!v1AllowsAutomatedSubscriptionBilling()) fail(token, "phase-2");

  const signerName = String(formData.get("signerName") ?? "").trim();
  const signerTitle = String(formData.get("signerTitle") ?? "").trim();
  const businessLegalName = String(formData.get("businessLegalName") ?? "").trim();
  const signerEmail = String(formData.get("signerEmail") ?? "").trim().toLowerCase();
  const accepted = formData.get("agreementAccepted") === "yes";
  const authorityAccepted = formData.get("authorityAccepted") === "yes";
  const renewalAccepted = formData.get("renewalAccepted") === "yes";
  const billing = resolveBillingSchedule(offer, formData.get("billingSchedule"));

  if (signerName.length < 2 || signerName.length > 120) fail(token, "signer");
  if (signerTitle.length < 2 || signerTitle.length > 100) fail(token, "title");
  if (businessLegalName.length < 2 || businessLegalName.length > 160) fail(token, "business");
  if (!accepted || !authorityAccepted || !renewalAccepted) fail(token, "agreement");
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

  try {
    let customerId = salon.stripe_customer_id?.trim() ?? "";
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: signerEmail,
        name: salon.name ?? offer.salonName,
        metadata: { salon_id: offer.salonId, salon_slug: offer.salonSlug },
      }, { idempotencyKey: `private-offer-customer-${offer.salonId}` });
      customerId = customer.id;
      const { error: updateError } = await db.from("salons").update({ stripe_customer_id: customerId }).eq("id", offer.salonId);
      if (updateError) throw updateError;
    }

    const acceptedAt = new Date().toISOString();
    const requestHeaders = await headers();
    const acceptanceIp = (requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? requestHeaders.get("x-real-ip") ?? "unknown").slice(0, 100);
    const metadata = {
      salon_id: offer.salonId,
      salon_slug: offer.salonSlug,
      plan: offer.plan,
      private_offer_key: offer.accessKey,
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
      setup_fee_cents: billing.schedule === "monthly" ? String(offer.monthlySetupAmountCents) : "0",
    };
    const origin = getStripeReturnOrigin();
    const recurringLineItem = {
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: billing.amount,
        recurring: {
          interval: billing.interval,
          ...(billing.intervalCount ? { interval_count: billing.intervalCount } : {}),
        },
        product_data: { name: `NailIQ Managed Salon — ${offer.salonName}` },
      },
    };
    const setupLineItem = {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: offer.monthlySetupAmountCents,
          product_data: { name: `NailIQ one-time setup — ${offer.salonName}` },
        },
      };
    const lineItems = billing.schedule === "monthly"
      ? [recurringLineItem, setupLineItem]
      : [recurringLineItem];
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      billing_address_collection: "required",
      client_reference_id: offer.salonId,
      line_items: lineItems,
      metadata,
      subscription_data: { metadata },
      success_url: `${origin}/offer/${offer.accessKey}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/offer/${offer.accessKey}?checkout=cancelled`,
    }, { idempotencyKey: `private-offer-checkout-${offer.salonId}-${billing.schedule}-${acceptedAt.slice(0, 16)}` });
    if (!session.url) fail(token, "stripe");
    redirect(session.url);
  } catch (checkoutError) {
    unstable_rethrow(checkoutError);
    console.error("[private offer] checkout creation failed", checkoutError);
    fail(token, "stripe");
  }
}
