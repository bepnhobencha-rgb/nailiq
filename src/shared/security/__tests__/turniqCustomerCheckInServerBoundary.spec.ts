import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const migration = read(
  "supabase/migrations/20260902124728_add_turniq_customer_checkin_shadow_ledger.sql",
);
const route = read("src/app/api/turniq/customer-checkin/route.ts");
const server = read("src/shared/turniq/customerCheckInServer.ts");
const proxy = read("src/proxy.ts");

describe("TurnIQ M4M customer check-in server boundary", () => {
  it("creates a forced-RLS, service-role-only capability and append-only ledger", () => {
    for (const table of [
      "turniq_customer_checkin_capabilities",
      "turniq_customer_checkin_receipts",
    ]) {
      expect(migration).toContain(`CREATE TABLE public.${table}`);
      expect(migration).toContain(
        `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`,
      );
      expect(migration).toContain(
        `ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`,
      );
    }
    expect(migration).toContain("reject_turniq_customer_checkin_receipt_mutation");
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE[\s\S]*?turniq_customer_checkin_receipts[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/,
    );
    expect(migration).not.toMatch(/GRANT[^;]*TO anon|GRANT[^;]*TO authenticated/i);
  });

  it("uses hash-only short-lived capability and exact-once shadow receipts", () => {
    expect(migration).toContain("token_hash text NOT NULL UNIQUE");
    expect(migration).toContain("p_expires_at > pg_catalog.clock_timestamp() + interval '24 hours'");
    expect(migration).toContain("UNIQUE (salon_id, command_id)");
    expect(migration).toContain("idempotency_conflict");
    expect(migration).toContain("FOR UPDATE");
    expect(server).toContain("turniq-customer-checkin-capability-v1");
    expect(server).not.toContain("p_capability_token:");
  });

  it("revalidates feature, tenant, booking, service and requested staff in SQL", () => {
    expect(migration).toContain("turniq_trust_engine_enabled");
    expect(migration).toContain("b.salon_id = v_capability.salon_id");
    expect(migration).toContain("b.service_id = p_service_id");
    expect(migration).toContain("s.salon_id = v_capability.salon_id");
    expect(migration).toContain("c.service_id IS NULL OR c.service_id = NEW.service_id");
    expect(migration).toContain("requested_staff_mismatch");
  });

  it("cannot mutate operational or provider truth", () => {
    expect(migration).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM) public\.bookings/i);
    expect(migration).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM) public\.turniq_assignments/i);
    expect(`${migration}\n${server}\n${route}`).not.toMatch(
      /createPayment|sendSms|sendEmail|twilio|resend|squareClient|stripeClient/i,
    );
    expect(migration).toContain("status text NOT NULL DEFAULT 'shadow_received'");
  });

  it("has same-origin, bounded-body, durable IP and capability rate limits", () => {
    expect(proxy).toContain('"/api/turniq/"');
    expect(route).toContain("isSameOriginMutation(request)");
    expect(route).toContain("MAX_BODY_BYTES = 4_096");
    expect(route.match(/consumePublicRequestRateLimit\(/g)).toHaveLength(2);
    expect(route).toContain('scope: "turniq-customer-checkin-capability"');
    expect(route.indexOf("consumePublicRequestRateLimit")).toBeLessThan(
      route.indexOf("recordTurnIqCustomerCheckInShadow("),
    );
  });

  it("keeps browser roles away from both SQL RPCs", () => {
    for (const fn of [
      "issue_turniq_customer_checkin_capability_v1",
      "revoke_turniq_customer_checkin_capability_v1",
      "record_turniq_customer_checkin_shadow_v1",
    ]) {
      expect(migration).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([\\s\\S]*?FROM PUBLIC, anon, authenticated, service_role`),
      );
      expect(migration).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([\\s\\S]*?TO service_role`),
      );
    }
  });
});
