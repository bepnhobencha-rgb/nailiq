import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const migration = read("supabase/migrations/20260822163246_add_authoritative_tip_commission_evidence.sql");
const rehearsal = read("scripts/security/rehearse-tip-commission-evidence.sql");
const concurrency = read("scripts/security/rehearse-tip-commission-concurrency.mjs");

describe("MQA-0116/MQA-0118 tip and commission evidence boundary", () => {
  it("locks the approved product semantics without inventing a salon rate", () => {
    expect(migration).toContain("tips-staff-100-proportional-v1");
    expect(migration).toContain("commission-estimate-net-service-v1");
    expect(migration).toContain("estimate_not_payroll");
    expect(migration).toContain("after_discount_service_revenue_excluding_tax_and_tips");
    expect(migration).toContain("commission_rate_basis_points BETWEEN 0 AND 10000");
    expect(migration).not.toMatch(/DEFAULT\s+[0-9]+\s*.*commission_rate_basis_points/i);
  });

  it("uses immutable credit/debit evidence with cent-conserving allocation", () => {
    expect(migration).toContain("financial metric evidence is immutable");
    expect(migration).toContain("after_discount_service_subtotal_largest_remainder");
    expect(migration).toContain("difference_of_cumulative_clawback");
    expect(migration).toContain("financial reversal exceeds remaining evidence basis");
    expect(rehearsal).toContain("tip largest-remainder allocation is wrong");
    expect(rehearsal).toContain("commission cumulative clawback is wrong");
  });

  it("serializes replay and prevents concurrent over-reversal", () => {
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(concurrency).toContain("Promise.allSettled");
    expect(concurrency).toContain('assert.deepEqual(tipRace.sort(), ["false", "true"])');
    expect(concurrency).toContain('assert.deepEqual(commissionRace.sort(), ["false", "true"])');
    expect(concurrency).toContain('assert.equal(summary, "1:1:200:1000")');
  });

  it("keeps tables private and mutation RPCs service-only", () => {
    expect(migration.match(/FORCE ROW LEVEL SECURITY/g)).toHaveLength(2);
    expect(migration).toContain("REVOKE ALL ON TABLE public.booking_financial_metric_evidence");
    expect(migration).toContain("GRANT SELECT ON TABLE public.booking_financial_metric_evidence TO service_role");
    expect(migration).not.toContain("GRANT SELECT ON TABLE public.booking_financial_metric_evidence TO authenticated");
    expect(rehearsal).toContain("financial metric mutation RPC leaked to a browser role");
  });

  it("adds evidence to the existing PII-minimized financial DTO", () => {
    expect(migration).toContain("load_authoritative_financial_report_base_v2");
    expect(migration).toContain("metric_events");
    expect(migration).toContain("metric_policies");
    expect(migration).toContain("commission_estimate_not_payroll");
    expect(rehearsal).toContain("financial report leaked customer or owner PII");
  });

  it("keeps the exact schema/grant tripwire current", () => {
    const parity = read("scripts/check-schema-parity.ts");
    expect(parity).toContain("tables: 174");
    expect(parity).toContain("columns: 2560");
    expect(parity).toContain("policies: 197");
    expect(parity).toContain("functions: 363");
    expect(parity).toContain("triggers: 83");
    expect(parity).toContain("indexes: 632");
    expect(parity).toContain("service_role: 175");
  });
});
