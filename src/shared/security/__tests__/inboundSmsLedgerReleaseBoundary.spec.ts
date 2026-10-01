import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReleaseSchemaContract } from "./releaseSchemaContract";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const parity = read("scripts/check-schema-parity.ts");
const boundary = read("scripts/security/check-inbound-sms-ledger-boundary.sql");

describe("signed inbound SMS release ledger boundary", () => {
  it("pins the measured shape without adding direct role grants", () => {
    assertReleaseSchemaContract(parity);
    for (const name of ["sms_inbound_booking_receipts", "cancel_booking_from_signed_sms", "confirm_booking_from_signed_sms",
      "cancel_booking_with_verified_sms_waitlist", "reject_sms_inbound_receipt_mutation"]) {
      expect(parity).toContain(`"${name}"`);
    }
  });

  it("checks table and column grants, FORCE RLS, and the enabled immutable trigger", () => {
    expect(boundary).toContain("c.relrowsecurity AND c.relforcerowsecurity");
    expect(boundary).toContain("information_schema.role_table_grants");
    expect(boundary).toContain("information_schema.role_column_grants");
    expect(boundary).toContain("grantee IN ('PUBLIC','anon','authenticated','service_role')");
    expect(boundary).toContain("t.tgenabled='O'");
    expect(boundary).toContain("t.tgtype=27");
  });

  it("allows only the exact service RPC and pins helper privilege/search-path shape", () => {
    expect(boundary).toContain("('public.cancel_booking_from_signed_sms(text,text,text,text,text)',true,true)");
    expect(boundary).toContain("('public.confirm_booking_from_signed_sms(text,text,text,text,text)',true,true)");
    expect(boundary).toContain("('public.cancel_booking_with_verified_sms_waitlist(uuid)',false,false)");
    expect(boundary).toContain("('public.reject_sms_inbound_receipt_mutation()',false,false)");
    expect(boundary).toContain("has_function_privilege('anon',v_oid,'EXECUTE')");
    expect(boundary).toContain("has_function_privilege('authenticated',v_oid,'EXECUTE')");
    expect(boundary).toContain("has_function_privilege('service_role',v_oid,'EXECUTE') IS DISTINCT FROM v_service");
    expect(boundary).toContain("ARRAY['search_path=\"\"']");
  });

  it("runs the metadata gate immediately after parity in blank migration CI", () => {
    const workflow = read(".github/workflows/migration-history-rehearsal.yml");
    expect(workflow).toMatch(/DB_URL="\$\{DB_URL\}" npx tsx scripts\/check-schema-parity\.ts\s+psql[^\n]+\n\s+-f scripts\/security\/check-inbound-sms-ledger-boundary\.sql/);
  });

  it("reruns the atomic confirmation scenarios when their SQL fixture changes", () => {
    const workflow = read(".github/workflows/migration-history-rehearsal.yml");
    const triggers = workflow.split("  workflow_dispatch:")[0];
    expect(triggers).toContain('"supabase/tests/inbound_sms_confirm_atomic.sql"');
  });

  it("executes the real atomic confirmation fixture in a rollback transaction in CI", () => {
    const workflow = read(".github/workflows/migration-history-rehearsal.yml");
    expect(workflow).toMatch(
      /-f scripts\/security\/check-inbound-sms-ledger-boundary\.sql\s+psql "\$DB_URL" -X -v ON_ERROR_STOP=1 -q \\\n\s+-c 'BEGIN' \\\n\s+-f supabase\/tests\/inbound_sms_confirm_atomic\.sql \\\n\s+-c 'ROLLBACK'/,
    );
  });
});
