import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260901222628_add_turniq_trust_foundation.sql",
);
const featureRegistry = read("src/shared/features/featureRegistry.ts");

const tables = [
  "turniq_policy_versions",
  "turniq_shift_sessions",
  "turniq_assignments",
  "turniq_command_receipts",
  "turniq_events",
  "turniq_fairness_receipts",
  "turniq_exceptions",
  "turniq_disputes",
] as const;

describe("TurnIQ M1B trust foundation boundary", () => {
  it("keeps TurnIQ default OFF and outside the generic release editor", () => {
    expect(featureRegistry).toContain('| "turniq_trust_engine"');
    expect(featureRegistry).toMatch(
      /turniq_trust_engine:\s*\{[\s\S]*?defaultOn: false,[\s\S]*?flagKey: "turniq_trust_engine_enabled"/,
    );
    expect(featureRegistry).toMatch(
      /CONTROLLED_ROLLOUT_RELEASE_FLAG_KEYS[\s\S]*?"turniq_trust_engine_enabled"/,
    );
  });

  it("creates the complete additive policy, state, ledger, receipt, and exception set", () => {
    for (const table of tables) {
      expect(migration).toContain(`CREATE TABLE public.${table}`);
      expect(migration).toContain(
        `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`,
      );
      expect(migration).toContain(
        `ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`,
      );
    }
    expect(migration).toContain("turniq_policy_effective_boundary");
    expect(migration).toContain(
      "TurnIQ policy changes take effect next salon-local business day",
    );
  });

  it("separates fairness truth from actual business truth", () => {
    expect(migration).toContain("opportunity_credit_cents integer");
    expect(migration).toContain("actual_service_revenue_cents integer");
    expect(migration).toContain("actual_tax_cents integer");
    expect(migration).toContain("actual_tip_cents integer");
    expect(migration).toContain(
      "Fairness truth only: catalog/list price plus permitted add-ons, before tax and tip.",
    );
  });

  it("retains requested-technician provenance and does not upgrade staff claims", () => {
    for (const source of [
      "customer_selected",
      "ai_confirmed",
      "staff_entered",
      "in_person",
      "imported",
      "override",
      "legacy_unknown",
    ]) {
      expect(migration).toContain(`'${source}'`);
    }
    expect(migration).toMatch(
      /requested_tech_source = 'staff_entered'[\s\S]*?request_trust_label = 'customer_claim_recorded'/,
    );
    expect(migration).toContain("requested_tech_actor_ref text");
    expect(migration).toContain("requested_tech_recorded_at timestamptz");
  });

  it("denies browser access and exposes no direct authenticated policy", () => {
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE[\s\S]*?turniq_disputes[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/,
    );
    expect(migration).not.toMatch(/CREATE POLICY[\s\S]*?turniq_/i);
    expect(migration).not.toMatch(/GRANT[^;]*TO anon|GRANT[^;]*TO authenticated/i);
    expect(migration).toMatch(
      /GRANT SELECT, INSERT ON TABLE[\s\S]*?turniq_fairness_receipts[\s\S]*?TO service_role/,
    );
  });

  it("makes policy, command, event, and fairness receipt evidence immutable", () => {
    expect(migration).toContain("TurnIQ trust evidence is immutable");
    for (const trigger of [
      "reject_turniq_policy_mutation",
      "reject_turniq_command_mutation",
      "reject_turniq_event_mutation",
      "reject_turniq_receipt_mutation",
    ]) {
      expect(migration).toContain(`CREATE TRIGGER ${trigger}`);
    }
    expect(migration).toContain(
      "UNIQUE (salon_id, aggregate_type, aggregate_id, aggregate_version)",
    );
    expect(migration).toContain("UNIQUE (salon_id, device_id, local_sequence)");
    expect(migration).toContain("turniq_assignment_override_reason_check");
    expect(migration).toContain("turniq_receipt_override_reason_check");
    expect(migration).toContain("assignment_outcome text NOT NULL");
  });

  it("guards references against silent cross-salon linkage", () => {
    expect(migration).toContain("enforce_turniq_same_salon_references");
    for (const target of [
      "policy",
      "shift staff",
      "booking",
      "booking segment",
      "recommended staff",
      "assigned staff",
      "requested staff",
      "service",
      "resource",
      "event assignment",
      "receipt assignment",
      "exception assignment",
      "dispute reference",
    ]) {
      expect(migration).toContain(`TurnIQ ${target}`);
    }
    expect(migration).toContain("SECURITY INVOKER");
    expect(migration).not.toContain("SECURITY DEFINER");
  });

  it("keeps the migration inert with an explicit audit-preserving rollback", () => {
    expect(migration).toContain(
      "salons.feature_flags.turniq_trust_engine_enabled is absent/false",
    );
    expect(migration).toContain(
      "Preserve ledger rows as audit evidence; do not drop them during an incident.",
    );
    expect(migration).not.toMatch(/ALTER TABLE public\.bookings\s/i);
    expect(migration).not.toMatch(/UPDATE public\.salons|INSERT INTO public\.salons/i);
  });
});
