import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root=process.cwd();
const migration=readFileSync(resolve(root,
  "supabase/migrations/20260820131500_add_customer_booking_transition_email_outbox.sql"),"utf8");
const workflow=readFileSync(resolve(root,".github/workflows/migration-history-rehearsal.yml"),"utf8");
const parity=readFileSync(resolve(root,"scripts/check-schema-parity.ts"),"utf8");

describe("customer booking transition email DB boundary",()=>{
  it("keeps tokenized RPCs and outbox state service-role only",()=>{
    for(const name of [
      "load_customer_booking_transition_email_material",
      "activate_customer_booking_transition_email",
      "discover_due_customer_booking_transition_emails",
      "cancel_booking_as_customer_with_transition_email",
      "reschedule_booking_as_customer_with_transition_email",
      "claim_customer_booking_transition_email",
      "complete_customer_booking_transition_email",
      "lease_due_customer_booking_transition_email_retries",
      "reconcile_stale_customer_booking_transition_email_claims",
    ]){
      expect(migration).toMatch(new RegExp(`create or replace function public\\.${name}`,"i"));
      expect(migration).toMatch(new RegExp(`revoke all on function public\\.${name}[\\s\\S]*?from public,anon,authenticated`,"i"));
      expect(migration).toMatch(new RegExp(`grant execute on function public\\.${name}[\\s\\S]*?to service_role`,"i"));
    }
    expect(migration.match(/SECURITY DEFINER/g)).toHaveLength(10);
    expect(migration.match(/SET search_path TO ''/g)).toHaveLength(10);
    expect(migration).toContain("FOR ALL TO anon,authenticated USING(false) WITH CHECK(false)");
  });

  it("captures explicit email choice atomically while legacy writers stay inert",()=>{
    expect(migration).toContain("customer_transition_email_requested boolean NOT NULL DEFAULT false");
    expect(migration).toContain("current_setting('role',true)='service_role'");
    expect(migration).toContain("NEW.customer_transition_email_requested := false");
    expect(migration).toContain("'awaiting_activation'");
    expect(migration).toContain("available_at");
    expect(migration).toContain("v_now+interval '30 minutes'");
    expect(migration).not.toContain("NEW.start_time_utc-interval '30 minutes'");
  });

  it("binds occurrence, recipient, rendered payload, attempt token and receipt truth",()=>{
    expect(migration).toContain("customer_booking_transition_email_occurrence_once");
    expect(migration).toContain("recipient_fingerprint_mismatch");
    expect(migration).toContain("material_conflict");
    expect(migration).toContain("completion_conflict");
    expect(migration).toContain("customer_booking_transition_email_sent_receipt_check");
    expect(migration).toContain("email_rate_limited_pre_acceptance");
    expect(migration).toContain("stale_sending_outcome_unknown");
    expect(migration.match(/FOR UPDATE SKIP LOCKED/g)).toHaveLength(3);
  });

  it("wires behavior, concurrency, rollback, preflight and schema parity gates",()=>{
    for(const path of [
      "check-customer-booking-transition-email-boundary.sql",
      "preflight-customer-booking-transition-email-rollout.sql",
      "rehearse-customer-booking-transition-email.sql",
      "rehearse-customer-booking-transition-email-concurrency.mjs",
      "rehearse-customer-booking-transition-email-rollback.sql",
    ]) expect(workflow).toContain(path);
    expect(parity).toContain("20260820131500");
    expect(parity).toContain('"customer_booking_transition_email_outbox"');
    expect(parity).toContain('"claim_customer_booking_transition_email"');
  });
});
