"use server";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";

import { getStripeClient, getStripeReturnOrigin } from "@/shared/lib/stripe";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getPrivateOffer } from "@/shared/sales/privateOffers";

function fail(token: string, code: string): never {
  redirect(`/offer/${encodeURIComponent(token)}?error=${encodeURIComponent(code)}`);
}

export async function startPrivateOfferCheckout(token: string, formData: FormData): Promise<never> {
  const offer = getPrivateOffer(token);
  if (!offer) redirect("/");

  const signerName = String(formData.get("signerName") ?? "").trim();
  const signerTitle = String(formData.get("signerTitle") ?? "").trim();
  const businessLegalName = String(formData.get("businessLegalName") ?? "").trim();
  const signerEmail = String(formData.get("signerEmail") ?? "").trim().toLowerCase();
  const accepted = formData.get("agreementAccepted") === "yes";
  const authorityAccepted = formData.get("authorityAccepted") === "yes";
  const renewalAccepted = formData.get("renewalAccepted") === "yes";
  const billingSchedule = formData.get("billingSchedule") === "annual" ? "annual" : "monthly";

  if (signerName.length < 2 || signerName.length > 120) fail(token, "signer");
  if (signerTitle.length < 2 || signerTitle.length > 100) fail(token, "title");
  if (businessLegalName.length < 2 || businessLegalName.length > 160) fail(token, "business");
  if (!accepted || !authorityAccepted || !renewalAccepted) fail(token, "agreement");

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
      billing_schedule: billingSchedule,
    };
    const amount = billingSchedule === "annual" ? offer.annualAmountCents : offer.monthlyAmountCents;
    const origin = getStripeReturnOrigin();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      billing_address_collection: "required",
      client_reference_id: offer.salonId,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: amount,
          recurring: { interval: billingSchedule === "annual" ? "year" : "month" },
          product_data: { name: `NailIQ Managed Salon — ${offer.salonName}` },
        },
      }],
      metadata,
      subscription_data: { metadata },
      success_url: `${origin}/offer/${offer.accessKey}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/offer/${offer.accessKey}?checkout=cancelled`,
    }, { idempotencyKey: `private-offer-checkout-${offer.salonId}-${billingSchedule}-${acceptedAt.slice(0, 16)}` });
    if (!session.url) fail(token, "stripe");
    redirect(session.url);
  } catch (checkoutError) {
    unstable_rethrow(checkoutError);
    console.error("[private offer] checkout creation failed", checkoutError);
    fail(token, "stripe");
  }
}
