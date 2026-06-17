import { NextRequest, NextResponse } from "next/server";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { noShowCardDecision } from "@/shared/integrations/square/noshow";
import { resolvePaymentProvider } from "@/shared/integrations/payments";
import { getStripeClient } from "@/shared/lib/stripe";
import { isRateLimited, RATE_LIMIT_IDS } from "@/shared/lib/rateLimit";
import { isOverRateLimit, clientIp } from "@/shared/lib/inAppRateLimit";

export const runtime = "nodejs";

/**
 * POST /api/booking/stripe-setup-intent  Body: { bookingId }
 *
 * For a Stripe-provider salon where this booking must leave a card (new /
 * high-risk), creates a SetupIntent (save card, NO charge) and returns the
 * client_secret + publishable key + fee so the client can mount the Payment
 * Element (incl. Apple Pay / Google Pay one-tap). Returns { required:false }
 * whenever it's not applicable — so the client renders nothing.
 */
export async function POST(req: NextRequest) {
  let body: { bookingId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ required: false });
  }
  const bookingId = String(body.bookingId ?? "");
  if (!bookingId) return NextResponse.json({ required: false });

  // Anti card-testing — two layers: Vercel WAF rule (fail-open until created)
  // AND an app-level DB limiter (enforces on any plan): 6/min per IP+booking.
  const ip = clientIp(req);
  if (
    (await isRateLimited(RATE_LIMIT_IDS.cardSave, {
      request: req,
      rateLimitKey: `card-save:${bookingId}`,
    })) ||
    (await isOverRateLimit(`card-save:${ip}:${bookingId}`, 6, 60))
  ) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  try {
    const decision = await noShowCardDecision(bookingId);
    if (!decision.required) return NextResponse.json({ required: false });

    const db = looseServiceClient();
    const { data } = await db
      .from("bookings")
      .select("salon_id")
      .eq("id", bookingId)
      .maybeSingle();
    const salonId = String((data as Row | null)?.salon_id ?? "");
    if (!salonId) return NextResponse.json({ required: false });

    // Only the Stripe path uses this endpoint; Square uses square-noshow-config.
    const provider = await resolvePaymentProvider(salonId);
    if (!provider || provider.kind !== "stripe") {
      return NextResponse.json({ required: false });
    }
    const stripe = getStripeClient();
    if (!stripe) return NextResponse.json({ required: false });

    const si = await stripe.setupIntents.create({
      usage: "off_session", // card will be charged later only on a no-show
      automatic_payment_methods: { enabled: true }, // enables Apple/Google Pay
      metadata: { bookingId, purpose: "noshow_card_on_file" },
    });

    return NextResponse.json({
      required: true,
      clientSecret: si.client_secret,
      publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "",
      feeCents: decision.feeCents,
    });
  } catch (e) {
    console.error("[stripe-setup-intent]", e);
    // Best-effort — never block the booking flow on the card step.
    return NextResponse.json({ required: false });
  }
}
