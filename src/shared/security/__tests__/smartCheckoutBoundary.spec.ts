import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260831161048_add_smart_checkout_foundation.sql"),
  "utf8",
);

const aclMigration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260831162305_restrict_smart_checkout_service_role_acl.sql",
  ),
  "utf8",
);

describe("Smart Checkout database boundary", () => {
  it("keeps device, session, and cart truth service-only", () => {
    for (const table of [
      "smart_checkout_devices",
      "smart_checkout_sessions",
      "smart_checkout_lines",
    ]) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
      expect(migration).toContain(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated`);
    }

    expect(aclMigration).toMatch(
      /REVOKE ALL PRIVILEGES ON TABLE[\s\S]*?smart_checkout_devices[\s\S]*?smart_checkout_sessions[\s\S]*?smart_checkout_lines[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/,
    );
    expect(aclMigration).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON TABLE[\s\S]*?smart_checkout_devices[\s\S]*?smart_checkout_sessions[\s\S]*?TO service_role/,
    );
    expect(aclMigration).toMatch(
      /GRANT SELECT, INSERT ON TABLE[\s\S]*?smart_checkout_lines[\s\S]*?TO service_role/,
    );
    expect(aclMigration).not.toMatch(
      /GRANT[^;]*(?:UPDATE|DELETE|TRUNCATE)[^;]*smart_checkout_lines/i,
    );
  });

  it("requires human approval before provider dispatch and a receipt before paid", () => {
    expect(migration).toContain("smart_checkout_sessions_dispatch_check");
    expect(migration).toContain("approved_by IS NOT NULL");
    expect(migration).toContain("smart_checkout_sessions_paid_check");
    expect(migration).toContain("provider_payment_id IS NOT NULL");
    expect(migration).toContain("status IN ('pending_provider', 'outcome_unknown')");
  });

  it("deduplicates requests, provider checkouts, and provider payments", () => {
    expect(migration).toContain("UNIQUE (salon_id, request_id)");
    expect(migration).toContain("smart_checkout_sessions_provider_checkout_once");
    expect(migration).toContain("smart_checkout_sessions_provider_payment_once");
  });

  it("prevents cross-salon device and cart references", () => {
    expect(migration).toContain("smart_checkout_sessions_booking_tenant_fkey");
    expect(migration).toContain("booking_id, salon_id");
    expect(migration).toContain("smart_checkout_sessions_device_tenant_fkey");
    expect(migration).toContain("device_id, salon_id, provider");
    expect(migration).toContain("smart_checkout_lines_session_tenant_fkey");
    expect(migration).toContain("session_id, salon_id");
  });
});
