import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("Stripe subscription and webhook idempotency boundary", () => {
  const migration = read(
    "supabase/migrations/20260814040304_stripe_billing_idempotency.sql",
  );
  const checkout = read("src/shared/dashboard/stripeActions.ts");
  const privateOffer = read("src/app/offer/[token]/actions.ts");
  const webhook = read("src/app/api/stripe/webhook/route.ts");

  it("keeps both operational ledgers private and free of raw customer fields", () => {
    expect(migration).toContain(
      "alter table public.stripe_subscription_checkout_attempts\n  enable row level security",
    );
    expect(migration).toContain(
      "alter table public.stripe_webhook_events enable row level security",
    );
    expect(migration).toMatch(
      /revoke all on table public\.stripe_subscription_checkout_attempts[\s\S]*from public, anon, authenticated/,
    );
    expect(migration).toMatch(
      /revoke all on table public\.stripe_webhook_events[\s\S]*from public, anon, authenticated/,
    );
    expect(migration).not.toMatch(
      /\b(raw_payload|payload|customer_email|card_number)\b/i,
    );
    expect(migration).toContain("stripe_webhook_event_error_code_check");
    expect(migration).toContain(
      "stripe_subscription_checkout_error_code_check",
    );
  });

  it("enforces one active or pending Checkout per salon and plan", () => {
    expect(migration).toContain("salon_id uuid primary key");
    expect(migration).toContain(
      "plan text not null check (plan in ('pro', 'premium'))",
    );
    expect(migration).toContain("idempotency_key text not null unique");
    expect(migration).toContain("request_fingerprint text not null");
    expect(migration).toContain("for update;");
    expect(migration).toContain("'active_subscription'::text");
    expect(migration).toContain("'conflicting_plan'::text");
    expect(migration).toContain("'conflicting_request'::text");
    expect(migration).toContain("'pending'::text");
    expect(migration).toContain("lease_token = v_lease_token");
  });

  it("uses stable provider keys for customer and Checkout retries", () => {
    expect(migration).toContain("nailiq:subscription-checkout:%s:%s:%s");
    expect(checkout).toContain("`${claim.idempotencyKey}:customer`");
    expect(checkout).toContain("`${claim.idempotencyKey}:session`");
    expect(checkout).toContain('source: "stripe_price", priceId');
    expect(checkout).toContain("amount: catalogTermIdentity");
    expect(checkout).toContain("currency: catalogTermIdentity");
    expect(checkout).toContain("interval: catalogTermIdentity");
    expect(checkout).toContain("offerIdentity: priceId");
    expect(checkout).toContain('outcome: "retryable_failure"');
    expect(privateOffer).toContain("claimStripeSubscriptionCheckout({");
    expect(privateOffer).toContain("stripeCheckoutRequestFingerprint({");
    expect(privateOffer).toContain("amountCents: billing.amountCents");
    expect(privateOffer).toContain("currency: billing.currency");
    expect(privateOffer).toContain("interval: billing.interval");
    expect(privateOffer).toContain("offerIdentity,");
    expect(privateOffer).toContain("`${claim.idempotencyKey}:customer`");
    expect(privateOffer).toContain("`${claim.idempotencyKey}:session`");
  });

  it("claims provider event ids uniquely and fences completion", () => {
    expect(migration).toContain("event_id text primary key");
    expect(migration).toContain("on conflict (event_id) do nothing");
    expect(migration).toContain(
      "attempt_count = claimed_event.attempt_count + 1",
    );
    expect(migration).toContain("and lease_token = p_lease_token");
    expect(webhook).toContain("claimStripeWebhookEvent");
    expect(webhook).toContain("finishStripeWebhookEvent");
    expect(webhook).toContain('ledgerOutcome = "failed"');
  });

  it("allows only service role to execute ledger functions", () => {
    for (const signature of [
      "claim_stripe_subscription_checkout(uuid, text, text, timestamptz)",
      "finish_stripe_subscription_checkout(\n  uuid, uuid, text, text, text, timestamptz, text, timestamptz\n)",
      "reconcile_stripe_subscription_checkout(\n  uuid, uuid, text, text, text, text, text, timestamptz, timestamptz\n)",
      "mark_stripe_subscription_checkout_completed(\n  uuid, text, text, text, text, timestamptz\n)",
      "close_stripe_subscription_checkout(\n  uuid, text, text, timestamptz\n)",
      "claim_stripe_webhook_event(text, text, timestamptz)",
      "finish_stripe_webhook_event(text, uuid, text, text, timestamptz)",
    ]) {
      expect(migration).toContain(`revoke all on function public.${signature}`);
    }
    expect(migration.match(/\bto service_role;/g)).toHaveLength(9);
  });

  it("preserves the owner-only server gate and never deletes business data", () => {
    expect(checkout).toContain("if (!isOwner(resolved.role))");
    expect(checkout.indexOf("if (!isOwner(resolved.role))")).toBeLessThan(
      checkout.indexOf("claimStripeSubscriptionCheckout({"),
    );
    expect(
      privateOffer.indexOf("authorizedEmails.includes(signerEmail)"),
    ).toBeLessThan(privateOffer.indexOf("claimStripeSubscriptionCheckout({"));
    expect(migration).not.toMatch(/\bdelete\s+from\b/i);
    expect(webhook).not.toMatch(/\bdelete\s*\(/i);
  });

  it("binds subscription webhooks to persisted customer or subscription ids", () => {
    expect(webhook).toContain("stripe_salon_binding_mismatch");
    expect(webhook).toContain("requireExistingMatch && !customerMatches");
    expect(webhook).toContain("row.stripe_subscription_id !== subscriptionId");
    expect(webhook).toContain('error: "event_in_progress"');
    expect(webhook).toContain('"plan_metadata_invalid"');
    expect(webhook).toContain('"price_mapping_unknown"');
    expect(webhook).toContain('"provider_binding_incomplete"');
    expect(webhook).toContain('"salon_binding_not_found"');
    expect(webhook).toContain('"subscription_status_unsupported"');
    expect(webhook).toContain('"private_offer_terms_invalid"');
    expect(webhook).toContain("markStripeSubscriptionCheckoutCompleted");
    expect(webhook).not.toContain(
      'isSubscriptionPlan(meta.plan) ? meta.plan : "free"',
    );
  });

  it("fails migration safely before adding unique provider bindings", () => {
    expect(migration).toContain(
      "duplicate Stripe customer bindings block unique index creation",
    );
    expect(migration).toContain(
      "duplicate Stripe subscription bindings block unique index creation",
    );
    expect(migration).toContain("salons_stripe_customer_id_uq");
    expect(migration).toContain("where stripe_customer_id is not null");
    expect(migration).toContain("salons_stripe_subscription_id_uq");
    expect(migration).toContain("where stripe_subscription_id is not null");
  });

  it("requires provider reconciliation before rotating an expired Checkout", () => {
    expect(migration).toContain("state = 'reconciling'");
    expect(migration).toContain("'reconcile'::text");
    expect(migration).toContain("state = 'completed'");
    expect(migration).toContain("provider_status = 'subscription_terminal'");
    expect(migration).toContain("payment_succeeded");
    expect(migration).toContain("when provider_status = 'payment_succeeded'");
  });
});
