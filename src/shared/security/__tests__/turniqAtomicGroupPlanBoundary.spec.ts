import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260902034830_turniq_atomic_group_plan_ledger.sql",
  ),
  "utf8",
);

describe("TurnIQ M4B atomic group-plan boundary", () => {
  it("records a dedicated plan and immutable member ledger", () => {
    expect(sql).toContain("CREATE TABLE public.turniq_group_plans");
    expect(sql).toContain("CREATE TABLE public.turniq_group_plan_items");
    expect(sql).toContain("reject_turniq_group_plan_item_mutation");
    expect(sql).toMatch(/party_size smallint NOT NULL CHECK \(party_size BETWEEN 2 AND 12\)/);
  });

  it("revalidates every member before mutating any booking", () => {
    const confirm = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.confirm_turniq_group_plan_v1"));
    expect(confirm).toContain("TurnIQ group plan facts changed; refresh required");
    expect(confirm).toContain("TurnIQ group appointment gap is no longer safe");
    expect(confirm).toContain("TurnIQ group conflicts with live appointment capacity");
    expect(confirm.indexOf("FOR v_item IN")).toBeLessThan(
      confirm.indexOf("UPDATE public.turniq_assignments a"),
    );
    expect(confirm.indexOf("UPDATE public.turniq_assignments a")).toBeLessThan(
      confirm.indexOf("UPDATE public.bookings b"),
    );
  });

  it("lets the trusted planner select an unassigned resource but preserves an existing choice", () => {
    expect(sql).toMatch(
      /IF v_booking\.resource_id IS NOT NULL\s+AND v_resource_id IS DISTINCT FROM v_booking\.resource_id THEN/,
    );
    expect(sql).toContain("group resource is not active");
    expect(sql).toContain("TurnIQ group conflicts with live appointment capacity");
  });

  it("uses established deterministic capacity locks and exactly-once receipts", () => {
    expect(sql).toContain("booking-capacity:staff:");
    expect(sql).toContain("booking-capacity:resource:");
    expect(sql).toContain("turniq_replay_online_command");
    expect(sql).toContain("turniq_store_online_command");
    expect(sql).toContain("INSERT INTO public.turniq_fairness_receipts");
  });

  it("keeps browser roles out and does not weaken RLS", () => {
    expect(sql).not.toMatch(/SECURITY DEFINER/i);
    expect(sql).toMatch(/ALTER TABLE public\.turniq_group_plans FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.turniq_group_plans FROM PUBLIC, anon, authenticated, service_role/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.confirm_turniq_group_plan_v1[\s\S]+FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.confirm_turniq_group_plan_v1[\s\S]+TO service_role/);
  });
});
