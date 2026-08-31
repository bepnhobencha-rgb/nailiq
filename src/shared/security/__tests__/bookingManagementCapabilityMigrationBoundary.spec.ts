import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const booking = readFileSync(resolve(root,
  "supabase/migrations/20260820140000_add_action_scoped_booking_management_capabilities.sql"), "utf8");
const cardReconciliation = readFileSync(resolve(root,
  "supabase/migrations/20260827085412_add_durable_booking_card_reconciliation.sql"), "utf8");
const cardReconciliationLease = readFileSync(resolve(root,
  "supabase/migrations/20260827231246_harden_card_reconciliation_leases.sql"), "utf8");
const waitlist = readFileSync(resolve(root,
  "supabase/migrations/20260820143000_add_action_scoped_waitlist_claim_capabilities.sql"), "utf8");
const workflow = readFileSync(resolve(root, ".github/workflows/migration-history-rehearsal.yml"), "utf8");
const parity = readFileSync(resolve(root, "scripts/check-schema-parity.ts"), "utf8");
const rehearsal = readFileSync(resolve(root,
  "scripts/security/rehearse-booking-management-capabilities.sql"), "utf8");

describe("MQA-0099 database capability boundary", () => {
  it("keeps booking actions separate, service-only, replay-bound, and side-effect explicit", () => {
    for (const action of ["status", "confirm", "reschedule", "cancel", "card_manage",
      "group_status", "group_reschedule", "group_cancel"]) expect(booking).toContain(`'${action}'`);
    expect(booking).toContain("inspect_booking_management_capability");
    expect(booking).toContain("exchange_public_booking_card_management_capability");
    expect(booking).toContain("public_booking_pricing_fingerprint=p_pricing_fingerprint");
    expect(booking).toContain("idempotency_mismatch");
    expect(booking).toContain("booking_version");
    expect(booking).toContain("pg_advisory_xact_lock");
    expect(booking).toContain("customer_transition_version");
    expect(booking).toContain("cancel_preview");
    expect(booking).toContain("attendance_status");
    expect(booking).toContain("rsvp_semantic");
    expect(booking).toContain("promoted_waitlist");
    expect(booking).toContain("claim_booking_card_management_operation");
    expect(booking).toContain("complete_booking_card_management_operation");
    expect(booking).toContain("claim_booking_card_save_operation");
    expect(booking).toContain("complete_booking_card_save_operation");
    expect(booking).toContain("finalize_token_id");
    expect(booking).toContain("setup_not_authorized");
    expect(booking).toMatch(/REVOKE ALL[\s\S]+FROM PUBLIC,anon,authenticated/);
  });

  it("reconciles an ambiguous card save by exact provider reads without redispatch", () => {
    expect(cardReconciliation).toContain("prepare_booking_card_save_dispatch");
    expect(cardReconciliation).toContain("'nq-card:' || v_op.id::text");
    expect(cardReconciliation).toContain("complete_booking_card_save_reconciliation");
    expect(cardReconciliation).toContain("customer_reentry_required");
    expect(cardReconciliation).toContain("REVOKE ALL ON FUNCTION");
    expect(cardReconciliation).not.toContain("source_token");
  });

  it("keeps the applied reconciliation migration immutable and adds leases forward-only", () => {
    expect(cardReconciliation).not.toContain("reconciliation_token");
    expect(cardReconciliation).not.toContain("reconciliation_lease_expires_at");
    expect(cardReconciliationLease).toContain("ADD COLUMN IF NOT EXISTS reconciliation_token");
    expect(cardReconciliationLease).toContain("ADD COLUMN IF NOT EXISTS reconciliation_lease_expires_at");
    expect(cardReconciliationLease).toContain("FOR UPDATE SKIP LOCKED");
    expect(cardReconciliationLease).toContain("v_op.reconciliation_token <> p_attempt_token");
    expect(cardReconciliationLease).toContain("v_op.reconciliation_lease_expires_at <= v_now");
    expect(cardReconciliationLease).toContain("WHEN v_count >= 3 THEN 'manual_review_required'");
    expect(cardReconciliationLease).not.toContain("source_token");
  });

  it("uses a new waitlist capability and a truthful at-most-one delivery claim", () => {
    expect(waitlist).toContain("claim_waitlist_with_management_capability");
    expect(waitlist).toContain("claim_waitlist_offer_delivery");
    expect(waitlist).toContain("load_waitlist_offer_delivery_material");
    expect(waitlist).toContain("promote_waitlist_for_freed_slot");
    expect(waitlist).toContain("promote_waitlist_for_booking");
    expect(waitlist).toContain("promote_waitlist_entry");
    expect(waitlist).toContain("advance_waitlist_offer_capabilities");
    expect(waitlist).toContain("cancel_booking_by_id_with_waitlist_offer");
    expect(waitlist).toContain("sms_outbound_enabled");
    expect(waitlist).toContain("email_outbound_enabled");
    expect(waitlist).toContain("p_material_fingerprint text");
    expect(waitlist).toContain("offer_unavailable");
    expect(waitlist).toContain("status IN ('pending','sending','sent','failed','unknown','suppressed')");
    expect(waitlist).toContain("provider_receipt~'^(SM|MM)[0-9a-fA-F]{32}$'");
    expect(waitlist).toContain("REVOKE ALL ON FUNCTION public.claim_waitlist_slot(uuid) FROM PUBLIC,anon,authenticated");
  });

  it("wires executable proof and exact schema tripwires", () => {
    for (const proof of ["check-booking-management-capability-boundary.sql",
      "rehearse-booking-management-capabilities.sql",
      "rehearse-booking-management-capabilities-concurrency.mjs",
      "rehearse-waitlist-claim-capabilities.sql",
      "rehearse-waitlist-claim-capabilities-concurrency.mjs"]) expect(workflow).toContain(proof);
    expect(parity).toContain("tables: 200");
    expect(parity).toContain("columns: 3049");
    expect(parity).toContain("functions: 444");
    expect(parity).toContain("indexes: 756");
    expect(parity).toContain("service_role: 188");
  });

  it("keeps the freed-slot auto-book fixture inside salon hours at every wall-clock time", () => {
    expect(rehearsal).toContain("interval '3 days 12 hours'");
    expect(rehearsal).toContain("interval '3 days 12 hours 30 minutes'");
    expect(rehearsal).not.toContain("transaction_timestamp()+interval '3 days 30 minutes'");
  });
});
