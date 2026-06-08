import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getStripeClient } from "@/shared/lib/stripe";
import { evaluateDeposit } from "@/shared/noshow/evaluateDeposit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Creates a Stripe PaymentIntent for a booking deposit, charged ON THE SALON'S
 * connected account (so the money goes to the salon, not the platform).
 *
 * Everything that affects the amount is re-derived server-side from the DB — the
 * client never supplies the charge amount. Returns the connected-account id +
 * publishable key so the browser can mount Stripe Elements scoped to that account.
 *
 * Dormant unless the salon has completed Connect onboarding (charges_enabled).
 */
type Body = {
  salonId?: string;
  serviceId?: string;
  /** Risk signals are re-derived from this phone server-side (never trusted from
   *  the client) so a customer can't fake VIP/clean-history to dodge a deposit. */
  clientPhone?: string;
};

// Stripe zero-decimal currencies take the amount in whole units, not cents.
const ZERO_DECIMAL = new Set(["VND", "JPY", "KRW"]);

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const salonId = String(body.salonId ?? "").trim();
  const serviceId = String(body.serviceId ?? "").trim();
  if (!salonId || !serviceId) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  const stripe = getStripeClient();
  if (!stripe) {
    return NextResponse.json({ error: "stripe_not_configured" }, { status: 503 });
  }
  const publishableKey = (process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "").trim();
  if (!publishableKey) {
    return NextResponse.json({ error: "stripe_not_configured" }, { status: 503 });
  }

  const db = createServiceRoleClient();

  const { data: salon } = await db
    .from("salons" as never)
    .select(
      "currency_code, deposit_high_value_cents, deposit_pct_no_show, deposit_pct_high_value, deposit_pct_new_customer, stripe_connect_account_id, stripe_connect_charges_enabled",
    )
    .eq("id", salonId)
    .maybeSingle();
  const s = (salon ?? {}) as {
    currency_code?: string | null;
    deposit_high_value_cents?: number;
    deposit_pct_no_show?: number;
    deposit_pct_high_value?: number;
    deposit_pct_new_customer?: number;
    stripe_connect_account_id?: string | null;
    stripe_connect_charges_enabled?: boolean;
  };

  // Salon must have a connected account that can accept charges.
  if (!s.stripe_connect_account_id || !s.stripe_connect_charges_enabled) {
    return NextResponse.json({ error: "salon_not_connected" }, { status: 409 });
  }

  // Re-derive the service price (never trust the client).
  const { data: svc } = await db
    .from("services" as never)
    .select("price_cents")
    .eq("id", serviceId)
    .eq("salon_id", salonId)
    .is("deleted_at" as never, null)
    .maybeSingle();
  const priceCents = Number((svc as { price_cents?: number } | null)?.price_cents);
  if (!Number.isFinite(priceCents) || priceCents <= 0) {
    return NextResponse.json({ error: "service_not_found" }, { status: 404 });
  }

  // Re-derive risk signals from the phone-keyed client profile (server-side).
  let isNewCustomer = true;
  let noShowCount = 0;
  let isVip = false;
  const phone = String(body.clientPhone ?? "").trim();
  if (phone) {
    const { data: profile } = await db
      .from("client_profiles" as never)
      .select("no_show_count, is_vip, visit_count")
      .eq("phone", phone)
      .maybeSingle();
    const p = (profile ?? {}) as {
      no_show_count?: number;
      is_vip?: boolean;
      visit_count?: number;
    };
    noShowCount = Math.max(0, Math.round(Number(p.no_show_count) || 0));
    isVip = Boolean(p.is_vip);
    isNewCustomer = !(Number(p.visit_count) > 0);
  }

  const decision = evaluateDeposit({
    isNewCustomer,
    previousNoShowCount: noShowCount,
    isVip,
    servicePriceCents: priceCents,
    highValueThresholdCents: s.deposit_high_value_cents ?? 10000,
    pctNoShow: s.deposit_pct_no_show,
    pctHighValue: s.deposit_pct_high_value,
    pctNewCustomer: s.deposit_pct_new_customer,
  });

  if (!decision.required || decision.amountCents <= 0) {
    return NextResponse.json({ required: false });
  }

  const currency = (s.currency_code ?? "USD").toUpperCase();
  const stripeAmount = ZERO_DECIMAL.has(currency)
    ? Math.round(decision.amountCents / 100)
    : Math.round(decision.amountCents);

  try {
    const intent = await stripe.paymentIntents.create(
      {
        amount: stripeAmount,
        currency: currency.toLowerCase(),
        // Direct charge on the connected account → funds land in the salon's
        // balance. metadata ties it back for the webhook + record step.
        metadata: { salon_id: salonId, service_id: serviceId, kind: "booking_deposit" },
        description: "Booking deposit",
      },
      { stripeAccount: s.stripe_connect_account_id },
    );

    return NextResponse.json({
      required: true,
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      connectedAccountId: s.stripe_connect_account_id,
      publishableKey,
      amountCents: decision.amountCents,
      currency,
    });
  } catch (e) {
    console.error("[deposit-intent]", e);
    return NextResponse.json({ error: "stripe_error" }, { status: 502 });
  }
}
