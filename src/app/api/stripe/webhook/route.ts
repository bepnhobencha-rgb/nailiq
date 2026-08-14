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
import { graceDeadline, resumeTenant } from "@/shared/subscriptions/tenantPause";
import {
  claimStripeWebhookEvent,
  finishStripeWebhookEvent,
} from "@/shared/subscriptions/stripeWebhookLedger";

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
 * env vars to map a price id to one paid plan. Missing/unknown plan
 * truth fails closed and remains retryable; it never downgrades a salon.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;
// Run on Node so we have access to the raw body buffer for signature
// verification. Edge runtime would need a different verifyAsync path.
export const runtime = "nodejs";

function planForPriceId(
  priceId: string | null | undefined,
): Exclude<SubscriptionPlan, "free"> | null {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_PRO) return "pro";
  if (priceId === process.env.STRIPE_PRICE_PREMIUM) return "premium";
  return null;
}

type StripeWebhookFailureCode =
  | "plan_metadata_invalid"
  | "price_mapping_unknown"
  | "provider_binding_incomplete"
  | "salon_binding_not_found";

class StripeWebhookFailure extends Error {
  constructor(readonly safeCode: StripeWebhookFailureCode) {
    super(safeCode);
    this.name = "StripeWebhookFailure";
  }
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
  payment_grace_ends_at?: string | null;
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
  const supabase = createServiceRoleClient();

  type StripeBindingRow = {
    id: string;
    stripe_customer_id: string | null;
    stripe_subscription_id: string | null;
  };
  const lookup = async (
    column: "id" | "stripe_customer_id" | "stripe_subscription_id",
    value: string,
  ): Promise<StripeBindingRow | null> => {
    const { data, error } = await supabase
      .from("salons")
      .select("id,stripe_customer_id,stripe_subscription_id")
      .eq(column, value)
      .maybeSingle();
    if (error) throw new Error("stripe_salon_binding_lookup_failed");
    return (data ?? null) as StripeBindingRow | null;
  };

  const assertBinding = (
    row: StripeBindingRow,
    requireExistingMatch: boolean,
  ): void => {
    const customerMatches = Boolean(
      customerId && row.stripe_customer_id === customerId,
    );
    const subscriptionMatches = Boolean(
      subscriptionId && row.stripe_subscription_id === subscriptionId,
    );
    if (
      (customerId &&
        row.stripe_customer_id &&
        row.stripe_customer_id !== customerId) ||
      (subscriptionId &&
        row.stripe_subscription_id &&
        row.stripe_subscription_id !== subscriptionId) ||
      (requireExistingMatch && !customerMatches && !subscriptionMatches)
    ) {
      throw new Error("stripe_salon_binding_mismatch");
    }
  };

  if (salonIdMeta && salonIdMeta.trim().length > 0) {
    const row = await lookup("id", salonIdMeta.trim());
    if (!row) return null;
    // Metadata is a routing hint, never proof of tenant ownership. Require the
    // signed event's customer or subscription to match a persisted salon id.
    assertBinding(row, true);
    return row.id;
  }
  if (subscriptionId) {
    const row = await lookup("stripe_subscription_id", subscriptionId);
    if (row) {
      assertBinding(row, false);
      return row.id;
    }
  }
  if (customerId) {
    const row = await lookup("stripe_customer_id", customerId);
    if (row) {
      assertBinding(row, false);
      return row.id;
    }
  }
  return null;
}

async function applyPatch(
  salonId: string,
  patch: SalonPatch,
): Promise<void> {
  const supabase = createServiceRoleClient();
  const { data: state, error: stateError } = await supabase
    .from("salons")
    .select("archived_at, tenant_pause_reason, payment_grace_ends_at" as never)
    .eq("id", salonId)
    .maybeSingle();
  if (stateError) throw new Error("stripe_salon_state_lookup_failed");
  const current = state as unknown as {
    archived_at?: string | null;
    tenant_pause_reason?: string | null;
    payment_grace_ends_at?: string | null;
  } | null;

  // The first past-due event starts a fixed seven-day grace period. Repeated
  // Stripe retries must not extend it indefinitely.
  if (
    patch.subscription_status === "past_due" &&
    !current?.archived_at &&
    !current?.payment_grace_ends_at
  ) {
    patch.payment_grace_ends_at = graceDeadline(7);
  }
  if (patch.subscription_status === "active" || patch.subscription_status === "trialing") {
    patch.payment_grace_ends_at = null;
  }
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

  // Successful payment only auto-resumes a tenant paused specifically for
  // non-payment. A manual Superadmin pause always remains manual.
  if (
    (patch.subscription_status === "active" || patch.subscription_status === "trialing") &&
    current?.archived_at &&
    current.tenant_pause_reason === "non_payment"
  ) {
    const resumed = await resumeTenant(supabase, salonId);
    if (!resumed.ok) {
      console.error("[stripe webhook] auto-resume", resumed.error);
      throw resumed.error;
    }
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

  let eventClaim;
  try {
    eventClaim = await claimStripeWebhookEvent({
      eventId: event.id,
      eventType: event.type,
      now: new Date(),
    });
  } catch {
    console.error("[stripe webhook] event claim failed");
    return NextResponse.json(
      { ok: false, error: "event_claim_failed" },
      { status: 503 },
    );
  }

  if (eventClaim.outcome === "duplicate") {
    return NextResponse.json({
      ok: true,
      duplicate: true,
      state: eventClaim.outcome,
    });
  }
  if (eventClaim.outcome === "in_progress") {
    // Do not acknowledge a concurrent delivery until the lease owner commits.
    // If that worker dies, Stripe must retain a retry opportunity.
    return NextResponse.json(
      { ok: false, error: "event_in_progress" },
      { status: 503 },
    );
  }
  if (eventClaim.outcome !== "acquired" || !eventClaim.leaseToken) {
    console.error("[stripe webhook] event claim rejected", eventClaim.outcome);
    return NextResponse.json(
      { ok: false, error: "event_claim_rejected" },
      { status: 503 },
    );
  }

  let ledgerOutcome: "processed" | "failed" = "processed";
  let ledgerErrorCode: string | null = null;
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
      if (!customerId || !subscriptionId) {
        throw new StripeWebhookFailure("provider_binding_incomplete");
      }
      if (!isSubscriptionPlan(meta.plan) || meta.plan === "free") {
        throw new StripeWebhookFailure("plan_metadata_invalid");
      }
      const planMeta = meta.plan;
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
        throw new StripeWebhookFailure("salon_binding_not_found");
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
        const { error } = await db
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
        if (error) throw new Error("stripe_deposit_backstop_failed");
      }
      return NextResponse.json({ ok: true });
    }

    if (event.type === "customer.subscription.updated") {
      const sub = event.data.object as Stripe.Subscription;
      const customerId =
        typeof sub.customer === "string"
          ? sub.customer
          : (sub.customer?.id ?? null);
      if (!customerId) {
        throw new StripeWebhookFailure("provider_binding_incomplete");
      }
      const priceId = sub.items.data[0]?.price?.id ?? null;
      const resolvedPlan = planForPriceId(priceId);
      if (!resolvedPlan) {
        throw new StripeWebhookFailure("price_mapping_unknown");
      }
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
        throw new StripeWebhookFailure("salon_binding_not_found");
      }
      const patch: SalonPatch = {
        subscription_plan: resolvedPlan,
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
      if (!customerId) {
        throw new StripeWebhookFailure("provider_binding_incomplete");
      }
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
        throw new StripeWebhookFailure("salon_binding_not_found");
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
    // Dispute writes are retried through the event ledger on database failure.
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
          const { data, error } = await db
            .from("bookings" as never)
            .select("id, salon_id, client_phone")
            .eq("stripe_payment_intent_id" as never, paymentIntent)
            .maybeSingle();
          if (error) throw new Error("stripe_dispute_booking_lookup_failed");
          bookingRow = data as BookingLookup;
        }
        if (!bookingRow && chargeId) {
          // Fall back: some bookings store the charge id in payment_ref-like columns
          const { data, error } = await db
            .from("bookings" as never)
            .select("id, salon_id, client_phone")
            .eq("stripe_payment_intent_id" as never, chargeId)
            .maybeSingle();
          if (error) throw new Error("stripe_dispute_booking_lookup_failed");
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

        const { error: disputeError } = await db
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
        if (disputeError) throw new Error("stripe_dispute_write_failed");

        return NextResponse.json({ ok: true });
      } catch (err) {
        console.error("[stripe webhook] dispute upsert error", err);
        throw new Error("stripe_dispute_write_failed");
      }
    }

    // Unhandled events ack so Stripe stops retrying.
    return NextResponse.json({ ok: true, ignored: event.type });
  } catch (e) {
    ledgerOutcome = "failed";
    ledgerErrorCode =
      e instanceof StripeWebhookFailure ? e.safeCode : "handler_failed";
    console.error("[stripe webhook] handler error", e);
    return NextResponse.json(
      { ok: false, error: "server_error" },
      { status: 500 },
    );
  } finally {
    const finalized = await finishStripeWebhookEvent({
      eventId: event.id,
      leaseToken: eventClaim.leaseToken,
      outcome: ledgerOutcome,
      errorCode: ledgerErrorCode,
      now: new Date(),
    });
    if (!finalized) {
      // A stale lease must never acknowledge success. Stripe will retry, and
      // the durable event claim will decide whether work is still needed.
      console.error("[stripe webhook] stale event lease", event.id);
      throw new Error("stripe_webhook_stale_lease");
    }
  }
}
