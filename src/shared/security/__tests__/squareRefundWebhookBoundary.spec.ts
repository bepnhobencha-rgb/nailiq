import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const migration = read(
  "supabase/migrations/20260823110412_add_durable_square_refund_webhook_ingestion.sql",
);
const route = read("src/app/api/webhooks/square/route.ts");
const runtime = read("src/shared/integrations/square/webhookRuntime.ts");
const rehearsal = read(
  "scripts/security/rehearse-square-refund-webhook-ingestion-concurrency.mjs",
);

describe("MQA-0126 Square refund webhook boundary", () => {
  it("admits only strictly projected refund.updated material after signature verification", () => {
    expect(runtime).toContain('event.eventType !== "refund.updated"');
    expect(runtime).toContain("event.dataId !== refundId");
    expect(runtime).toContain('["PENDING", "COMPLETED", "REJECTED", "FAILED"]');
    expect(route.indexOf("verifySquareWebhookSignature")).toBeLessThan(
      route.indexOf("createServiceRoleClient()"),
    );
    expect(route).toContain('event.eventType === "refund.updated"');
    expect(route).toContain('"record_square_refund_webhook_event"');
    expect(route).not.toMatch(/p_(?:raw|body|payload):/);
  });

  it("rechecks exact tenant and Square account identity inside the transaction", () => {
    expect(migration).toContain("WHERE salon_id = p_salon_id");
    expect(migration).toContain("AND merchant_id = p_merchant_id");
    expect(migration).toContain("AND location_id = p_location_id");
    expect(migration).toContain("AND application_id = p_application_id");
    expect(migration).toContain("AND environment = p_environment");
    expect(migration).toContain("AND enabled IS TRUE");
    expect(migration).toContain(
      "'square:' || p_merchant_id || ':' || p_location_id || ':' || p_environment",
    );
    expect(migration).toContain(
      "AND provider_account_fingerprint = v_account_fingerprint",
    );
    expect(migration).toContain("v_operation.parent_payment_id IS DISTINCT FROM p_parent_payment_id");
  });

  it("makes identical events no-ops and rejects conflicting event material", () => {
    expect(migration).toContain(
      "UNIQUE (provider_account_fingerprint, event_id)",
    );
    expect(migration).toContain(
      "ON CONFLICT (provider_account_fingerprint, event_id) DO NOTHING",
    );
    expect(migration).toContain("'code', 'event_replay'");
    expect(migration).toContain("'code', 'event_conflict'");
    expect(migration).toContain(
      "v_inbox.payload_fingerprint IS DISTINCT FROM p_payload_fingerprint",
    );
    expect(migration).toContain(
      "v_inbox.material_fingerprint IS DISTINCT FROM v_material_fingerprint",
    );
  });

  it("serializes operation adoption and never regresses terminal state", () => {
    expect(migration).toMatch(
      /FROM public\.booking_payment_operations[\s\S]+FOR UPDATE;/,
    );
    expect(migration).toContain("v_operation.status = 'succeeded'");
    expect(migration).toContain("v_operation.status = 'failed'");
    expect(migration).toContain("'terminal_state_conflict'");
    expect(migration).toContain("'stale_event_ignored'");
    expect(migration).toContain("public.complete_booking_payment_operation(");
    expect(rehearsal).toContain("Promise.all([");
    expect(rehearsal).toContain('["event_replay", "refund_pending"]');
    expect(rehearsal).toContain('missingOperation.code, "operation_not_found"');
    expect(rehearsal).toContain('recoveredOperation.code, "refund_applied"');
    expect(rehearsal).toContain('recoveredReplay.code, "event_replay"');
    expect(rehearsal).toContain('"5000:full:refunded"');
    expect(rehearsal).toContain('"stale_event_ignored"');
    expect(rehearsal).toContain('"provider_context_mismatch"');
  });

  it("keeps the inbox service-function-only under forced RLS", () => {
    expect(migration).toContain(
      "ALTER TABLE public.square_refund_webhook_inbox FORCE ROW LEVEL SECURITY",
    );
    expect(migration).toContain(
      "FROM PUBLIC, anon, authenticated, service_role",
    );
    expect(migration).toContain(
      ") FROM PUBLIC, anon, authenticated;",
    );
    expect(migration).toContain(") TO service_role;");
    expect(migration).toContain("DO $square_refund_acl$");
    expect(migration).toContain("has_table_privilege('service_role'");
    expect(migration).toContain("has_function_privilege('authenticated'");
    expect(migration).toContain("has_function_privilege('service_role'");
    expect(migration).not.toMatch(/GRANT (?:SELECT|INSERT|UPDATE|DELETE|ALL).*square_refund_webhook_inbox/i);
  });

  it("pins the disposable rehearsal to this repo's independently reported local DB", () => {
    expect(rehearsal).toContain("readLocalStackIdentity(process.cwd()");
    expect(rehearsal).toContain('stack.projectId !== "nailiq-e2e-local"');
    expect(rehearsal).toContain("runSupabaseStatus(stack)");
    expect(rehearsal).toContain("canonicalLocalDatabaseUrl(configuredDbUrl");
    expect(rehearsal).toContain("canonicalLocalDatabaseUrl(localStatus.dbUrl");
    expect(rehearsal).toContain("const dbUrl = localStatus.dbUrl");
  });
});
