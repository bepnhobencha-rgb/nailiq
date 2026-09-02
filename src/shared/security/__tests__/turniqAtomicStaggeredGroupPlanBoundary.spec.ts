import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260902042500_turniq_atomic_staggered_group_plan.sql",
  ),
  "utf8",
);

describe("TurnIQ M4G atomic staggered group-plan boundary", () => {
  it("adds typed timing provenance without creating a second group ledger", () => {
    expect(sql).toContain("ADD COLUMN planning_mode text NOT NULL DEFAULT 'fixed'");
    expect(sql).toContain("ADD COLUMN timing_intent text");
    expect(sql).toContain("ADD COLUMN source_simulation_id uuid");
    expect(sql).toContain("ADD COLUMN simulation_fingerprint text");
    expect(sql).not.toContain("CREATE TABLE public.turniq_staggered");
  });

  it("records the trusted simulation before any booking write", () => {
    const record = sql.slice(
      sql.indexOf(
        "CREATE OR REPLACE FUNCTION public.record_turniq_staggered_group_plan_v1",
      ),
      sql.indexOf(
        "CREATE OR REPLACE FUNCTION public.confirm_turniq_staggered_group_plan_v1",
      ),
    );
    expect(record).toContain("original_booking_material_fingerprint");
    expect(record).toContain("simulation_fingerprint");
    expect(record).not.toContain("UPDATE public.bookings");
  });

  it("proves all original fingerprints before one set-based move", () => {
    const confirm = sql.slice(
      sql.indexOf(
        "CREATE OR REPLACE FUNCTION public.confirm_turniq_staggered_group_plan_v1",
      ),
    );
    expect(confirm).toContain("TurnIQ staggered group facts changed; no booking moved");
    expect(confirm).toContain("ORDER BY b.id FOR UPDATE OF b");
    expect(confirm.indexOf("FOR v_item IN")).toBeLessThan(
      confirm.indexOf("UPDATE public.bookings b"),
    );
    expect(confirm).toContain("public.confirm_turniq_group_plan_v1");
    expect(confirm.indexOf("UPDATE public.bookings b")).toBeLessThan(
      confirm.indexOf("public.confirm_turniq_group_plan_v1("),
    );
  });

  it("keeps deterministic capacity locks and exact command replay", () => {
    expect(sql).toContain("booking-capacity:staff:");
    expect(sql).toContain("booking-capacity:resource:");
    expect(sql).toContain("turniq_replay_online_command");
    expect(sql).toContain("turniq_store_online_command");
    expect(sql).toContain("Return the exact M4B command receipt payload");
  });

  it("keeps both M4G functions service-only and invoker-secured", () => {
    expect(sql).not.toMatch(/SECURITY DEFINER/i);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.record_turniq_staggered_group_plan_v1[\s\S]+FROM PUBLIC, anon, authenticated/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.confirm_turniq_staggered_group_plan_v1[\s\S]+FROM PUBLIC, anon, authenticated/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.confirm_turniq_staggered_group_plan_v1[\s\S]+TO service_role/,
    );
  });
});
