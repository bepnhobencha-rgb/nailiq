import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260820123000_add_booking_confirmation_retry_contract.sql"),
  "utf8",
);
const smsPreacceptanceHotfix = readFileSync(
  resolve(root, "supabase/migrations/20260831071731_allow_sms_preacceptance_retry_codes.sql"),
  "utf8",
);
const workflow = readFileSync(
  resolve(root, ".github/workflows/migration-history-rehearsal.yml"),
  "utf8",
);
const parity = readFileSync(resolve(root, "scripts/check-schema-parity.ts"), "utf8");

describe("booking confirmation retry DB boundary", () => {
  it("keeps every tokenized RPC service-role only with an empty search path", () => {
    for (const name of [
      "claim_booking_confirmation_delivery",
      "complete_booking_confirmation_delivery",
      "lease_due_booking_confirmation_retries",
      "reconcile_stale_booking_confirmation_claims",
    ]) {
      expect(migration).toMatch(new RegExp(`create or replace function public\\.${name}`, "i"));
      expect(migration).toMatch(new RegExp(`revoke all on function public\\.${name}[\\s\\S]*?from public, anon, authenticated`, "i"));
      expect(migration).toMatch(new RegExp(`grant execute on function public\\.${name}[\\s\\S]*?to service_role`, "i"));
    }
    expect(migration.match(/SECURITY DEFINER/g)).toHaveLength(4);
    expect(migration.match(/SET search_path TO ''/g)).toHaveLength(4);
  });

  it("caps attempts and derives the allowlisted retry schedule in the database", () => {
    expect(migration).toContain("attempt_count BETWEEN 1 AND 2");
    expect(migration).toContain("interval '5 minutes'");
    expect(migration).toContain("% 61");
    expect(migration).toContain("interval '30 minutes'");
    expect(migration).toContain("sms_rate_limited_pre_acceptance");
    expect(migration).toContain("email_unavailable_pre_acceptance");
    expect(migration).toContain("unclassified_provider_outcome");
    expect(migration).not.toMatch(/next_attempt_at\s*=\s*p_/i);
  });

  it("keeps every dispatcher-proven SMS pre-acceptance failure retryable", () => {
    for (const code of [
      "sms_policy_unavailable_pre_acceptance",
      "consent_unavailable_pre_acceptance",
      "sms_delivery_truth_unavailable_pre_acceptance",
    ]) expect(smsPreacceptanceHotfix).toContain(code);
    expect(smsPreacceptanceHotfix).toContain(
      "complete_booking_confirmation_delivery_unserialized",
    );
    expect(smsPreacceptanceHotfix).toMatch(
      /revoke all on function public\.complete_booking_confirmation_delivery_unserialized[\s\S]*from public, anon, authenticated, service_role/i,
    );
    expect(smsPreacceptanceHotfix).toContain("retryable_pre_acceptance");
    expect(smsPreacceptanceHotfix).toContain("unclassified_provider_outcome");
  });

  it("uses attempt CAS, exact material binding, and skip-locked workers", () => {
    expect(migration).toContain("v_claim.attempt_token <> p_attempt_token");
    expect(migration).toContain("booking_material_fingerprint");
    expect(migration).toContain("recipient_fingerprint_mismatch");
    expect(migration.match(/FOR UPDATE SKIP LOCKED/g)).toHaveLength(2);
    expect(migration).toContain("stale_sending_outcome_unknown");
  });

  it("wires fresh behavior, concurrency, rollback, preflight, and parity gates", () => {
    for (const path of [
      "check-booking-confirmation-retry-boundary.sql",
      "preflight-booking-confirmation-retry-rollout.sql",
      "rehearse-booking-confirmation-retry.sql",
      "rehearse-booking-confirmation-retry-rollback.sql",
      "rehearse-booking-confirmation-retry-concurrency.mjs",
    ]) expect(workflow).toContain(path);
    expect(parity).toContain("20260820123000");
    expect(parity).toContain('"booking_notification_delivery_events"');
    expect(parity).toContain('"lease_due_booking_confirmation_retries"');
  });
});
