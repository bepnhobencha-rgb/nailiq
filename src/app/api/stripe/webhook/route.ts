import { NextResponse, type NextRequest } from "next/server";
import type Stripe from "stripe";

import { getStripeClient, getStripeWebhookSecret } from "@/shared/lib/stripe";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  isSubscriptionPlan,
  type SubscriptionPlan,
} from "@/shared/lib/subscriptionPlans";
import {
  getPrivateOfferBySalonId,
  privateOfferIdentity,
  resolvePrivateOfferBillingTerm,
} from "@/shared/sales/privateOffers";
import {
  closeStripeSubscriptionCheckout,
  markStripeSubscriptionCheckoutCompleted,
} from "@/shared/subscriptions/stripeCheckoutLedger";
import {
  graceDeadline,
  resumeTenant,
} from "@/shared/subscriptions/tenantPause";
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
 *   - checkout.session.completed       → synchronous first-time activation
 *   - checkout.session.async_payment_* → delayed-payment completion/failure
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
  | "checkout_binding_conflict"
  | "plan_metadata_invalid"
  | "private_offer_terms_invalid"
  | "price_mapping_unknown"
  | "provider_binding_incomplete"
  | "salon_binding_not_found"
  | "subscription_status_unsupported";

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
  subscription_status?: "active" | "trialing" | "past_due" | "canceled";
  subscription_current_period_end?: string | null;
  stripe_customer_id?: string;
  stripe_subscription_id?: string | null;
  payment_grace_ends_at?: string | null;
};

function normalizeStatus(
  s: string | null | undefined,
): SalonPatch["subscription_status"] {
  switch (s) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
    case "incomplete":
    case "unpaid":
    case "paused":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      throw new StripeWebhookFailure("subscription_status_unsupported");
  }
}

function metadataValue(
  metadata: Stripe.Metadata | null | undefined,
  key: string,
): string {
  const value = metadata?.[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolve a paid plan from provider data and trusted server-side pricing.
 *
 * New private offers carry a non-secret offer identity plus every recurring
 * term in Subscription metadata. Legacy offers are accepted only when the
 * actual recurring Price proves every trusted term, or (for a Checkout event
 * that does not include a Price) when the original capability key still
 * matches. Missing modern metadata always fails closed.
 */
function planForBilling(
  metadata: Stripe.Metadata | null | undefined,
  salonId: string,
  price?: Stripe.Price | null,
): Exclude<SubscriptionPlan, "free"> {
  const meta = metadata ?? {};
  const planMeta = metadataValue(meta, "plan");
  const source = metadataValue(meta, "pricing_source");
  const privateOfferKey = metadataValue(meta, "private_offer_key");
  const privateIdentity = metadataValue(meta, "private_offer_identity");
  const isPrivateOffer =
    source === "private_offer" || Boolean(privateOfferKey || privateIdentity);

  if (isPrivateOffer) {
    const offer = getPrivateOfferBySalonId(salonId);
    const schedule = metadataValue(meta, "billing_schedule");
    const term = offer ? resolvePrivateOfferBillingTerm(offer, schedule) : null;
    const priceMatches = Boolean(
      term &&
        price &&
        price.unit_amount === term.amountCents &&
        price.currency === term.currency &&
        price.recurring?.interval === term.interval &&
        price.recurring?.interval_count === term.intervalCount,
    );
    const modernMetadataMatches = Boolean(
      offer &&
        term &&
        source === "private_offer" &&
        privateIdentity === privateOfferIdentity(offer) &&
        metadataValue(meta, "recurring_amount_cents") ===
          String(term.amountCents) &&
        metadataValue(meta, "billing_currency") === term.currency &&
        metadataValue(meta, "billing_interval") === term.interval &&
        metadataValue(meta, "billing_interval_count") ===
          String(term.intervalCount),
    );
    const legacyProofMatches = Boolean(
      offer &&
        term &&
        !source &&
        !privateIdentity &&
        privateOfferKey &&
        (priceMatches ||
          (offer.accessKey && privateOfferKey === offer.accessKey)),
    );
    if (
      !offer ||
      !term ||
      planMeta !== offer.plan ||
      (!modernMetadataMatches && !legacyProofMatches) ||
      (modernMetadataMatches && price && !priceMatches)
    ) {
      throw new StripeWebhookFailure("private_offer_terms_invalid");
    }
    return offer.plan;
  }

  const catalogPriceId = price?.id ?? metadataValue(meta, "catalog_price_id");
  const catalogPlan = planForPriceId(catalogPriceId);
  if (catalogPlan) {
    if (
      (source && source !== "stripe_catalog") ||
      (planMeta && planMeta !== catalogPlan)
    ) {
      throw new StripeWebhookFailure("plan_metadata_invalid");
    }
    return catalogPlan;
  }

  // Compatibility for Checkout Sessions created before catalog_price_id was
  // copied into metadata. Subscription updates still require the real Price id.
  if (
    !price &&
    isSubscriptionPlan(planMeta) &&
    planMeta !== "free" &&
    !source
  ) {
    return planMeta;
  }
  if (!price && planMeta && !source) {
    throw new StripeWebhookFailure("plan_metadata_invalid");
  }
  throw new StripeWebhookFailure("price_mapping_unknown");
}

function checkoutObjectId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return null;
}

function isCardOnlyCheckout(session: Stripe.Checkout.Session): boolean {
  const methods = session.payment_method_types ?? [];
  return methods.length === 1 && methods[0] === "card";
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

async function applyPatch(salonId: string, patch: SalonPatch): Promise<void> {
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
  if (
    patch.subscription_status === "active" ||
    patch.subscription_status === "trialing"
  ) {
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
    (patch.subscription_status === "active" ||
      patch.subscription_status === "trialing") &&
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
    return NextResponse.json(
      { ok: false, error: "no_client" },
      { status: 503 },
    );
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
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded" ||
      event.type === "checkout.session.async_payment_failed"
    ) {
      const session = event.data.object as Stripe.Checkout.Session;
      const customerId = checkoutObjectId(session.customer);
      const subscriptionId = checkoutObjectId(session.subscription);
      const meta = session.metadata ?? {};
      if (!customerId || !subscriptionId) {
        throw new StripeWebhookFailure("provider_binding_incomplete");
      }
      const salonIdHint =
        metadataValue(meta, "salon_id") || session.client_reference_id || "";
      if (!salonIdHint) {
        throw new StripeWebhookFailure("provider_binding_incomplete");
      }
      const resolvedPlan = planForBilling(meta, salonIdHint);
      const salonId = await findSalonId({
        salonIdMeta: salonIdHint,
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

      const asyncSucceeded =
        event.type === "checkout.session.async_payment_succeeded";
      const asyncFailed =
        event.type === "checkout.session.async_payment_failed";
      const synchronousSuccess =
        event.type === "checkout.session.completed" &&
        (session.payment_status === "paid" || isCardOnlyCheckout(session));
      const providerStatus = asyncFailed
        ? "payment_failed"
        : asyncSucceeded || synchronousSuccess
          ? "payment_succeeded"
          : "payment_pending";
      const completion = await markStripeSubscriptionCheckoutCompleted({
        salonId,
        checkoutSessionId: session.id,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        providerStatus,
        now: new Date(),
      });
      // `missing` preserves safe compatibility for Checkouts created before the
      // durable attempt ledger existed. A mismatched/invalid known attempt is a
      // tenant-binding violation and must remain retryable for investigation.
      if (completion === "conflict" || completion === "invalid") {
        throw new StripeWebhookFailure("checkout_binding_conflict");
      }

      if (asyncSucceeded || synchronousSuccess) {
        await applyPatch(salonId, {
          subscription_plan: resolvedPlan,
          subscription_status: "active",
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
        });
      }
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
      const meta = sub.metadata ?? {};
      const price = sub.items.data[0]?.price ?? null;
      const salonIdHint = metadataValue(meta, "salon_id");
      if (!salonIdHint) {
        throw new StripeWebhookFailure("provider_binding_incomplete");
      }
      const resolvedPlan = planForBilling(meta, salonIdHint, price);
      const normalizedStatus = normalizeStatus(sub.status);
      const salonId = await findSalonId({
        salonIdMeta: salonIdHint,
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
      const terminal = normalizedStatus === "canceled";
      const patch: SalonPatch = {
        subscription_plan: terminal ? "free" : resolvedPlan,
        subscription_status: normalizedStatus,
        subscription_current_period_end: periodEndIso(sub),
        stripe_subscription_id: terminal ? null : sub.id,
      };
      if (customerId) patch.stripe_customer_id = customerId;
      await applyPatch(salonId, patch);
      if (terminal) {
        await closeStripeSubscriptionCheckout({
          salonId,
          stripeSubscriptionId: sub.id,
          now: new Date(),
        });
      }
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
      const salonIdHint = metadataValue(meta, "salon_id");
      const salonId = await findSalonId({
        salonIdMeta: salonIdHint || null,
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
      await closeStripeSubscriptionCheckout({
        salonId,
        stripeSubscriptionId: sub.id,
        now: new Date(),
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
          (dispute.evidence_details as { due_by?: number | null } | undefined)
            ?.due_by ?? null;
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
