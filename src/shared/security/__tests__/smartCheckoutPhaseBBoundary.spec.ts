import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260831170756_smart_checkout_phase_b.sql",
  ),
  "utf8",
);

describe("Smart Checkout Phase B database boundary", () => {
  it("keeps normalized webhooks and pairing attempts service-only and PII-free", () => {
    for (const table of [
      "smart_checkout_pairing_attempts",
      "smart_checkout_webhook_inbox",
    ]) {
      expect(migration).toContain(
        `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`,
      );
      expect(migration).toContain(
        `ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`,
      );
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL PRIVILEGES ON TABLE public\\.${table}\\s+FROM PUBLIC, anon, authenticated, service_role`,
        ),
      );
    }

    expect(migration).not.toMatch(/\b(?:raw_body|raw_payload|raw_pairing_code)\b/i);
    expect(migration).not.toMatch(/\b(?:client_phone|client_email|card_number|card_nonce)\b/i);
    expect(migration).toContain("pairing_code_fingerprint");
    expect(migration).toContain("normalized_material_fingerprint");
    expect(migration).toContain("key NOT IN ('session_id', 'failure_code')");
  });

  it("records signed normalized events idempotently without marking a session paid", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION public.record_smart_checkout_webhook_event(",
    );
    expect(migration).toContain(
      "ON CONFLICT (provider, provider_account_fingerprint, event_id) DO NOTHING",
    );
    expect(migration).toContain("'code', 'webhook_event_replay'");
    expect(migration).toContain(
      "convert_to(p_provider || ':' || trim(p_provider_account_id), 'UTF8')",
    );
    expect(migration).toMatch(
      /record_smart_checkout_webhook_event\([\s\S]*?p_provider text,[\s\S]*?p_salon_id uuid,[\s\S]*?p_event_id text,[\s\S]*?p_material jsonb/,
    );
    expect(migration).toMatch(
      /record_smart_checkout_webhook_event[\s\S]*?SET provider_checkout_id[\s\S]*?status = CASE[\s\S]*?'outcome_unknown'/,
    );
    const record = migration.slice(
      migration.indexOf(
        "CREATE OR REPLACE FUNCTION public.record_smart_checkout_webhook_event(",
      ),
      migration.indexOf(
        "CREATE OR REPLACE FUNCTION public.claim_due_smart_checkout_reconciliations(",
      ),
    );
    expect(record).not.toMatch(/SET status = 'paid'/);
  });

  it("leases due session and pairing work with bounded backoff", () => {
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toContain("reconciliation_attempt_count");
    expect(migration).toContain("reconciliation_lease_expires_at");
    expect(migration).toContain("attempt_count BETWEEN 0 AND 5");
    expect(migration).toContain("least(900, 15 * power(");
    expect(migration).toContain("reconciliation_retry_exhausted");
    expect(migration).toContain("pairing_retry_exhausted");
  });

  it("requires exact provider and paid-receipt binding before paid", () => {
    expect(migration).toContain("DROP CONSTRAINT smart_checkout_sessions_dispatch_check");
    expect(migration).toMatch(
      /ADD CONSTRAINT smart_checkout_sessions_dispatch_check[\s\S]*?'manual_review'/,
    );
    expect(migration).toContain("smart_checkout_sessions_paid_receipt_check");
    expect(migration).toContain("provider_receipt_fingerprint");
    expect(migration).toContain("v_session.amount_due_cents IS DISTINCT FROM p_amount_cents");
    expect(migration).toContain("v_session.currency IS DISTINCT FROM p_currency");
    expect(migration).toContain(
      "v_session.provider_account_fingerprint IS DISTINCT FROM p_provider_account_fingerprint",
    );
    expect(migration).toContain("v_session.device_id IS DISTINCT FROM p_device_id");
    expect(migration).toContain("'code', 'provider_binding_mismatch'");
    expect(migration).toContain("'code', 'paid_receipt_applied'");
    expect(migration).toContain(
      "p_outcome NOT IN ('paid', 'retry', 'failed', 'cancelled', 'manual_review')",
    );
    expect(migration).toContain("'code', 'reconciliation_retry_scheduled'");
    expect(migration).toContain("'provider_cancelled'");
  });

  it("exposes only narrow RPC execution and revokes direct service-role writes", () => {
    expect(migration).toContain("p_provider_account_fingerprint IS NULL");
    expect(migration).toContain("p_provider_status IS NULL");
    expect(migration).toContain("p_worker_id IS NULL");
    for (const rpc of [
      "request_smart_checkout_pairing",
      "claim_due_smart_checkout_pairings",
      "complete_smart_checkout_pairing",
      "record_smart_checkout_webhook_event",
      "claim_due_smart_checkout_reconciliations",
      "complete_smart_checkout_reconciliation",
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${rpc}(`);
      expect(migration).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${rpc}\\([\\s\\S]*?TO service_role`),
      );
    }
    expect(migration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE[\s\S]*?smart_checkout_devices[\s\S]*?smart_checkout_sessions[\s\S]*?smart_checkout_lines[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/,
    );
  });
});
