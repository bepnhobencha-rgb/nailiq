import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";

import {
  getStripeClient,
  getStripeWebhookSecret,
} from "@/shared/lib/stripe";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  isSubscriptionPlan,
  type SubscriptionPlan,
} from "@/shared/lib/subscriptionPlans";

/**
 * Stripe webhook receiver.
 *
 * Trust model: signature verification on every request (refuses to act
 * without a `STRIPE_WEBHOOK_SECRET` match). Writes via the service-
 * role Supabase client — webhook calls have no auth.uid so RLS would
 * deny otherwise.
 *
 * Handled events (others 200-OK without action — Stripe retries on
 * non-2xx, and silent acks keep dashboards quiet):
 *   - checkout.session.completed       → first-time activation
 *   - customer.subscription.updated    → plan changes / renewal
 *   - customer.subscription.deleted    → cancellation
 *
 * Plan dispatch reads `STRIPE_PRICE_PRO` / `STRIPE_PRICE_PREMIUM`
 * env vars to map a price id to one of our plan keys. Unknown price
 * ids fall through to "free" defensively — the row state always
 * matches Stripe truth at the time of the event.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Run on Node so we have access to the raw body buffer for signature
// verification. Edge runtime would need a different verifyAsync path.
export const runtime = "nodejs";

function planForPriceId(priceId: string | null | undefined): SubscriptionPlan {
  if (!priceId) return "free";
  if (priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  if (priceId === process.env.STRIPE_PRICE_PREMIUM) return "premium";
  return "free";
}

function periodEndIso(sub: Stripe.Subscription): string | null {
  // Stripe types `current_period_end` as `number` (unix seconds). Some
  // edge events surface 0 or null in beta APIs — guard before format.
  const raw = (sub as unknown as { current_period_end?: number | null })
    .current_period_end;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return new Date(raw * 1000).toISOString();
}

type SalonPatch = {
  subscription_plan?: SubscriptionPlan;
  subscription_status?:
    | "active"
    | "trialing"
    | "past_due"
    | "canceled";
  subscription_current_period_end?: string | null;
  stripe_customer_id?: string;
  stripe_subscription_id?: string | null;
};

function normalizeStatus(s: string | null | undefined): SalonPatch["subscription_status"] {
  switch (s) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
    case "incomplete":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return "active";
  }
}

async function findSalonId(args: {
  salonIdMeta?: string | null;
  customerId?: string | null;
  subscriptionId?: string | null;
}): Promise<string | null> {
  const { salonIdMeta, customerId, subscriptionId } = args;
  if (salonIdMeta && salonIdMeta.trim().length > 0) {
    return salonIdMeta.trim();
  }
  const supabase = createServiceRoleClient();
  if (subscriptionId) {
    const { data } = await supabase
      .from("salons")
      .select("id")
      .eq("stripe_subscription_id", subscriptionId)
      .maybeSingle();
    if (data?.id) return String(data.id);
  }
  if (customerId) {
    const { data } = await supabase
      .from("salons")
      .select("id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();
    if (data?.id) return String(data.id);
  }
  return null;
}

async function applyPatch(
  salonId: string,
  patch: SalonPatch,
): Promise<void> {
  const supabase = createServiceRoleClient();
  // Cast: subscription_* columns are not yet in the auto-generated DB
  // types until next regeneration.
  const { error } = await supabase
    .from("salons")
    .update(patch as never)
    .eq("id", salonId);
  if (error) {
    console.error("[stripe webhook] update", error);
    throw error;
  }
}

export async function POST(request: NextRequest) {
  const stripe = getStripeClient();
  if (!stripe) {
    // Dev-only path; missing key in prod throws inside getStripeClient.
    return NextResponse.json({ ok: false, error: "no_client" }, { status: 503 });
  }
  const webhookSigningKey = getStripeWebhookSecret();
  if (!webhookSigningKey) {
    console.error("[stripe webhook] STRIPE_WEBHOOK_SECRET missing");
    return NextResponse.json(
      { ok: false, error: "no_secret" },
      { status: 503 },
    );
  }

  const sig = request.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json(
      { ok: false, error: "missing_signature" },
      { status: 400 },
    );
  }

  // `request.text()` returns the raw body — required by
  // `constructEvent`; reading JSON first would re-encode and break the
  // signature.
  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSigningKey);
  } catch (e) {
    console.error("[stripe webhook] signature verification failed", e);
    return NextResponse.json(
      { ok: false, error: "invalid_signature" },
      { status: 400 },
    );
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const customerId =
        typeof session.customer === "string"
          ? session.customer
          : (session.customer?.id ?? null);
      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : (session.subscription?.id ?? null);
      const meta = session.metadata ?? {};
      const planMeta = isSubscriptionPlan(meta.plan) ? meta.plan : "free";
      const salonId = await findSalonId({
        salonIdMeta:
          typeof meta.salon_id === "string"
            ? meta.salon_id
            : (session.client_reference_id ?? null),
        customerId,
        subscriptionId,
      });
      if (!salonId) {
        console.error(
          "[stripe webhook] checkout.completed: salon not found",
          session.id,
        );
        return NextResponse.json({ ok: true });
      }
      const patch: SalonPatch = {
        subscription_plan: planMeta,
        subscription_status: "active",
      };
      if (customerId) patch.stripe_customer_id = customerId;
      if (subscriptionId) patch.stripe_subscription_id = subscriptionId;
      await applyPatch(salonId, patch);
      return NextResponse.json({ ok: true });
    }

    // Deposit backstop (Connect): a deposit PaymentIntent succeeded on a salon's
    // connected account. The record-deposit route is the primary path; this just
    // ensures the booking is stamped paid if that call was lost. Idempotent.
    if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object as Stripe.PaymentIntent;
      if (pi.metadata?.kind === "booking_deposit") {
        const db = createServiceRoleClient();
        await db
          .from("bookings" as never)
          .update({
            deposit_status: "paid",
            deposit_required: true,
            verification_method: "deposit",
            stripe_payment_intent_id: pi.id,
            deposit_paid_at: new Date().toISOString(),
          } as never)
          .eq("stripe_payment_intent_id", pi.id)
          .neq("deposit_status", "paid");
      }
      return NextResponse.json({ ok: true });
    }

    if (event.type === "customer.subscription.updated") {
      const sub = event.data.object as Stripe.Subscription;
      const customerId =
        typeof sub.customer === "string"
          ? sub.customer
          : (sub.customer?.id ?? null);
      const meta = sub.metadata ?? {};
      const salonId = await findSalonId({
        salonIdMeta: typeof meta.salon_id === "string" ? meta.salon_id : null,
        customerId,
        subscriptionId: sub.id,
      });
      if (!salonId) {
        console.error(
          "[stripe webhook] subscription.updated: salon not found",
          sub.id,
        );
        return NextResponse.json({ ok: true });
      }
      const priceId = sub.items.data[0]?.price?.id ?? null;
      const patch: SalonPatch = {
        subscription_plan: planForPriceId(priceId),
        subscription_status: normalizeStatus(sub.status),
        subscription_current_period_end: periodEndIso(sub),
        stripe_subscription_id: sub.id,
      };
      if (customerId) patch.stripe_customer_id = customerId;
      await applyPatch(salonId, patch);
      return NextResponse.json({ ok: true });
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object as Stripe.Subscription;
      const customerId =
        typeof sub.customer === "string"
          ? sub.customer
          : (sub.customer?.id ?? null);
      const meta = sub.metadata ?? {};
      const salonId = await findSalonId({
        salonIdMeta: typeof meta.salon_id === "string" ? meta.salon_id : null,
        customerId,
        subscriptionId: sub.id,
      });
      if (!salonId) {
        console.error(
          "[stripe webhook] subscription.deleted: salon not found",
          sub.id,
        );
        return NextResponse.json({ ok: true });
      }
      await applyPatch(salonId, {
        subscription_plan: "free",
        subscription_status: "canceled",
        stripe_subscription_id: null,
        subscription_current_period_end: periodEndIso(sub),
      });
      return NextResponse.json({ ok: true });
    }

    // ── Dispute events ───────────────────────────────────────────────────────
    // charge.dispute.created  — dispute opened against a charge
    // charge.dispute.updated  — evidence submitted / status changed
    // charge.dispute.closed   — dispute resolved (won/lost/charge_refunded)
    //
    // Never throws — disputes are non-critical telemetry; webhook always 200s.
    if (
      event.type === "charge.dispute.created" ||
      event.type === "charge.dispute.updated" ||
      event.type === "charge.dispute.closed"
    ) {
      try {
        const dispute = event.data.object as Stripe.Dispute;
        const db = createServiceRoleClient();

        // Resolve payment reference — prefer payment_intent, fall back to charge.
        const paymentIntent =
          typeof dispute.payment_intent === "string"
            ? dispute.payment_intent
            : (dispute.payment_intent?.id ?? null);
        const chargeId =
          typeof dispute.charge === "string"
            ? dispute.charge
            : (dispute.charge?.id ?? null);
        const paymentRef = paymentIntent ?? chargeId;

        // Look up the booking so we can link salon + client.
        // Try stripe_payment_intent_id first, then fall back via charge column.
        type BookingLookup = {
          id: string;
          salon_id: string;
          client_phone: string | null;
        } | null;

        let bookingRow: BookingLookup = null;
        if (paymentIntent) {
          const { data } = await db
            .from("bookings" as never)
            .select("id, salon_id, client_phone")
            .eq("stripe_payment_intent_id" as never, paymentIntent)
            .maybeSingle();
          bookingRow = data as BookingLookup;
        }
        if (!bookingRow && chargeId) {
          // Fall back: some bookings store the charge id in payment_ref-like columns
          const { data } = await db
            .from("bookings" as never)
            .select("id, salon_id, client_phone")
            .eq("stripe_payment_intent_id" as never, chargeId)
            .maybeSingle();
          bookingRow = data as BookingLookup;
        }

        const bookingId = bookingRow?.id ?? null;
        const salonId = bookingRow?.salon_id ?? null;
        const clientPhone = bookingRow?.client_phone ?? null;

        // Resolve evidence due date (unix seconds → ISO string).
        const dueBySecs =
          (
            dispute.evidence_details as
              | { due_by?: number | null }
              | undefined
          )?.due_by ?? null;
        const evidenceDueAt =
          typeof dueBySecs === "number" && dueBySecs > 0
            ? new Date(dueBySecs * 1000).toISOString()
            : null;

        await db
          .from("payment_disputes" as never)
          .upsert(
            {
              provider: "stripe",
              provider_dispute_id: dispute.id,
              payment_ref: paymentRef,
              booking_id: bookingId,
              salon_id: salonId,
              client_phone: clientPhone,
              amount_cents: dispute.amount,
              currency: dispute.currency,
              reason: dispute.reason,
              status: dispute.status,
              evidence_due_at: evidenceDueAt,
              raw: dispute as unknown as Record<string, unknown>,
              updated_at: new Date().toISOString(),
            } as never,
            { onConflict: "provider_dispute_id" },
          );

        return NextResponse.json({ ok: true });
      } catch (err) {
        console.error("[stripe webhook] dispute upsert error", err);
        // Never 5xx from a dispute event — Stripe would retry indefinitely.
        return NextResponse.json({ ok: true, _error: "dispute_write_failed" });
      }
    }

    // Unhandled events ack so Stripe stops retrying.
    return NextResponse.json({ ok: true, ignored: event.type });
  } catch (e) {
    console.error("[stripe webhook] handler error", e);
    return NextResponse.json(
      { ok: false, error: "server_error" },
      { status: 500 },
    );
  }
}
