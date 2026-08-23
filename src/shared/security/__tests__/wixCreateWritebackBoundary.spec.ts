import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read(
  "supabase/migrations/20260822181000_add_durable_wix_writeback_operations.sql",
);
const runtime = read("src/shared/integrations/wix/writeback.ts");
const client = read("src/shared/integrations/wix/client.ts");

describe("Wix create writeback duplicate-prevention boundary", () => {
  it("keeps the durable operation ledger server-only and PII-free by contract", () => {
    expect(migration).toContain(
      "ALTER TABLE public.wix_create_writeback_operations FORCE ROW LEVEL SECURITY",
    );
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.wix_create_writeback_operations[\s\S]*FROM PUBLIC, anon, authenticated, service_role/,
    );
    expect(migration).toContain(
      "GRANT SELECT ON TABLE public.wix_create_writeback_operations TO service_role",
    );
    expect(migration).toContain(
      "ALTER TABLE public.wix_lifecycle_writeback_operations FORCE ROW LEVEL SECURITY",
    );
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.wix_lifecycle_writeback_operations[\s\S]*FROM PUBLIC, anon, authenticated, service_role/,
    );
    expect(migration).toContain(
      "GRANT SELECT ON TABLE public.wix_lifecycle_writeback_operations TO service_role",
    );
    expect(migration).toContain("v_role <> 'service_role'");
    expect(migration).not.toMatch(
      /jsonb_build_object\([\s\S]{0,1200}'(client_name|client_phone|client_email|wix_api_key)'/,
    );
  });

  it("turns expired and unknown sends into reconciliation claims only", () => {
    expect(migration).toContain("'code', 'reconciliation_claimed'");
    expect(migration).toContain("status = 'reconciling'");
    expect(migration).toContain("provider_outcome_requires_reconciliation");
    expect(runtime).toContain('claim.code === "reconciliation_claimed"');
    expect(runtime).toContain('errorCode: "provider_booking_not_visible"');
    expect(runtime).toMatch(
      /if \(!providerBooking && claim\.code === "reconciliation_claimed"\)[\s\S]*?return;/,
    );
  });

  it("uses Wix's filterable externalUserId before any create and binds through the RPC", () => {
    expect(client).toContain("getBookingByExternalUserId");
    expect(client).toContain("filter: { externalUserId }");
    expect(runtime).toContain("externalUserId: bookingId");
    expect(runtime.indexOf("getBookingByExternalUserId")).toBeLessThan(
      runtime.indexOf("createWixBooking(integ.site_id, createBody)"),
    );
    expect(runtime).toContain('db.rpc("complete_wix_create_writeback"');
    expect(runtime).not.toContain("update({ wix_booking_id:");
  });

  it("makes confirm, cancel and decline response loss provider-read reconciliation only", () => {
    expect(migration).toContain("public.wix_lifecycle_writeback_operations");
    expect(migration).toContain("public.claim_wix_lifecycle_writeback");
    expect(migration).toContain("public.complete_wix_lifecycle_writeback");
    expect(runtime).toContain('db.rpc("claim_wix_lifecycle_writeback"');
    expect(runtime).toContain('db.rpc("complete_wix_lifecycle_writeback"');
    expect(runtime).toContain('claim.code === "reconciliation_claimed"');
    expect(runtime).toContain("provider_target_not_visible");
    expect(runtime).toContain("reconcileWixLifecycleWritebacks");
  });

  it("persists signed webhook event identity, lease, retry and completion server-side", () => {
    expect(migration).toContain("public.wix_webhook_event_inbox");
    expect(migration).toContain("public.record_wix_webhook_event");
    expect(migration).toContain("public.claim_wix_webhook_event");
    expect(migration).toContain("public.complete_wix_webhook_event");
    expect(migration).toContain(
      "ALTER TABLE public.wix_webhook_event_inbox FORCE ROW LEVEL SECURITY",
    );
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE public\.wix_webhook_event_inbox FROM PUBLIC,anon,authenticated,service_role/,
    );
  });
});
