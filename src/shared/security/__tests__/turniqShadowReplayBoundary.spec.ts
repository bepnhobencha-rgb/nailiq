import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260901224527_add_turniq_shadow_replay.sql",
  ),
  "utf8",
);

const tables = [
  "turniq_shadow_decisions",
  "turniq_shadow_comparisons",
  "turniq_replay_runs",
  "turniq_replay_cases",
] as const;

describe("TurnIQ M2 shadow/replay database boundary", () => {
  it("stores decision, later comparison, and replay as separate append-only facts", () => {
    for (const table of tables) {
      expect(migration).toContain(`CREATE TABLE public.${table}`);
      expect(migration).toContain(
        `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`,
      );
      expect(migration).toContain(
        `ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`,
      );
    }
    expect(migration).toContain("TurnIQ shadow and replay evidence is immutable");
    expect(migration.match(/BEFORE UPDATE OR DELETE/g)).toHaveLength(4);
  });

  it("keeps shadow and replay service-only with no browser policy", () => {
    expect(migration).toMatch(
      /REVOKE ALL ON TABLE[\s\S]*?turniq_replay_cases[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/,
    );
    expect(migration).toMatch(
      /GRANT SELECT, INSERT ON TABLE[\s\S]*?turniq_replay_cases[\s\S]*?TO service_role/,
    );
    expect(migration).not.toMatch(/CREATE POLICY/i);
    expect(migration).not.toMatch(/SECURITY DEFINER/i);
    expect(migration).not.toMatch(/GRANT[^;]*TO anon|GRANT[^;]*TO authenticated/i);
  });

  it("never hooks or mutates bookings, staff, resources, or live assignments", () => {
    expect(migration).not.toMatch(/ALTER TABLE public\.(bookings|staff|salon_resources)/i);
    expect(migration).not.toMatch(
      /(?:INSERT INTO|UPDATE|DELETE FROM) public\.(bookings|staff|salon_resources|turniq_assignments)/i,
    );
    expect(migration).not.toMatch(
      /CREATE TRIGGER[^;]* ON public\.(bookings|staff|salon_resources|turniq_assignments)/i,
    );
  });

  it("persists baseline metrics and marks replay read-only", () => {
    expect(migration).toContain("comparison_outcome text NOT NULL");
    expect(migration).toContain("owner_intervened boolean NOT NULL");
    expect(migration).toContain("assignment_latency_seconds integer");
    expect(migration).toContain(
      "No row means assignment is still pending.",
    );
    expect(migration).toContain("current_metrics jsonb NOT NULL");
    expect(migration).toContain("proposed_metrics jsonb NOT NULL");
    expect(migration).toContain("read_only boolean NOT NULL DEFAULT true CHECK (read_only)");
  });

  it("guards all existing-domain references against cross-salon linkage", () => {
    expect(migration).toContain("enforce_turniq_shadow_replay_same_salon");
    for (const message of [
      "TurnIQ shadow policy does not belong to salon",
      "TurnIQ shadow booking does not belong to salon",
      "TurnIQ shadow recommended staff does not belong to salon",
      "TurnIQ comparison decision does not belong to salon",
      "TurnIQ comparison staff does not belong to salon",
      "TurnIQ replay policy does not belong to salon",
      "TurnIQ replay run does not belong to salon",
      "TurnIQ replay decision does not belong to salon",
    ]) {
      expect(migration).toContain(message);
    }
  });

  it("documents and structurally excludes customer/provider material", () => {
    expect(migration).toContain(
      "must exclude customer name, phone, email, notes, tips, and provider data",
    );
    expect(migration).not.toMatch(
      /\b(?:client_name|client_phone|client_email|customer_name|customer_phone|card_id|payment_id|provider_payload)\b/i,
    );
  });
});
