import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getStripeClient } from "@/shared/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * After a deposit PaymentIntent is confirmed (Elements) and the booking is
 * created, link them: re-verify with Stripe that the PI actually succeeded on
 * the salon's connected account (never trust the client), then stamp the booking
 * as deposit-paid. The Stripe webhook is the backup if this call is lost.
 */
type Body = {
  bookingId?: string;
  paymentIntentId?: string;
  connectedAccountId?: string;
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const bookingId = String(body.bookingId ?? "").trim();
  const paymentIntentId = String(body.paymentIntentId ?? "").trim();
  const acct = String(body.connectedAccountId ?? "").trim();
  if (!bookingId || !paymentIntentId || !acct) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  const stripe = getStripeClient();
  if (!stripe) {
    return NextResponse.json({ error: "stripe_not_configured" }, { status: 503 });
  }
  const db = createServiceRoleClient();

  // The booking must exist + its salon must own the connected account we were
  // told to verify against (prevents pointing at another salon's PI).
  const { data: booking } = await db
    .from("bookings" as never)
    .select("id, salon_id, deposit_amount_cents")
    .eq("id", bookingId)
    .maybeSingle();
  const b = booking as
    | { id: string; salon_id: string; deposit_amount_cents?: number | null }
    | null;
  if (!b) return NextResponse.json({ error: "booking_not_found" }, { status: 404 });

  const { data: salon } = await db
    .from("salons" as never)
    .select("stripe_connect_account_id")
    .eq("id", b.salon_id)
    .maybeSingle();
  if (
    (salon as { stripe_connect_account_id?: string | null } | null)
      ?.stripe_connect_account_id !== acct
  ) {
    return NextResponse.json({ error: "account_mismatch" }, { status: 409 });
  }

  let succeeded = false;
  try {
    const pi = await stripe.paymentIntents.retrieve(
      paymentIntentId,
      undefined,
      { stripeAccount: acct },
    );
    succeeded =
      pi.status === "succeeded" &&
      pi.metadata?.salon_id === b.salon_id;
  } catch (e) {
    console.error("[record-deposit] retrieve", e);
    return NextResponse.json({ error: "stripe_error" }, { status: 502 });
  }
  if (!succeeded) {
    return NextResponse.json({ error: "payment_not_succeeded" }, { status: 409 });
  }

  const { error } = await db
    .from("bookings" as never)
    .update({
      deposit_required: true,
      deposit_status: "paid",
      verification_method: "deposit",
      verification_completed_at: new Date().toISOString(),
      stripe_payment_intent_id: paymentIntentId,
      deposit_paid_at: new Date().toISOString(),
    } as never)
    .eq("id", bookingId)
    .eq("salon_id", b.salon_id);
  if (error) {
    console.error("[record-deposit] update", error);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
