import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260902205914_add_turniq_pilot_hardening.sql",
), "utf8");
const qaParityHotfix = readFileSync(resolve(
  process.cwd(),
  "supabase/migrations/20260902214929_fix_turniq_special_form_qualification.sql",
), "utf8");
const serverDal = readFileSync(resolve(process.cwd(), "src/shared/turniq/serverDal.ts"), "utf8");

describe("TurnIQ M6 pilot hardening boundary", () => {
  it("projects the required operating and trust evidence without mutation", () => {
    for (const field of [
      "recommendation_acceptance_basis_points",
      "median_assignment_seconds",
      "wait_p50_minutes",
      "wait_p90_minutes",
      "walkaway_rate_basis_points",
      "walkaway_rate_is_proxy",
      "normal_turns_without_owner_basis_points",
      "unresolved_exceptions",
      "unresolved_disputes",
      "unresolved_offline_conflicts",
      "duplicate_command_conflicts",
      "owner_decision_seconds_observed",
      "offline_loss_evidence_complete",
      "request_source_counts",
      "opportunity_distribution",
      "opportunity_spread_cents",
    ]) expect(migration).toContain(`'${field}'`);
    expect(migration).toContain("STABLE");
    expect(migration).not.toContain("pg_catalog.extract(");
    expect(migration).not.toContain("pg_catalog.coalesce(");
    expect(migration).toContain("'booking:' || booking_id::text");
    expect(migration).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it("labels targets as hypotheses and gates exact owner evidence", () => {
    expect(migration).toContain("'targets_are_hypotheses', true");
    expect(migration).toContain("p_actor_role NOT IN ('owner', 'admin')");
    expect(serverDal).toContain("canSeeTurnIqOwnerFinancialTruth(context.role)");
  });

  it("remains service-role-only and preserves the ledger on rollback", () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*?FROM PUBLIC, anon, authenticated/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role/);
    expect(migration).not.toContain("SECURITY DEFINER");
    expect(migration).toContain("keep immutable TurnIQ ledgers");
  });

  it("keeps the QA parity hotfix limited to invoker function replacements", () => {
    expect(qaParityHotfix.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(14);
    expect(qaParityHotfix).not.toContain("pg_catalog.coalesce(");
    expect(qaParityHotfix).not.toContain("pg_catalog.extract(");
    expect(qaParityHotfix).not.toContain("SECURITY DEFINER");
    expect(qaParityHotfix).not.toMatch(/\b(CREATE TABLE|ALTER TABLE|DROP TABLE)\b/i);
  });
});
