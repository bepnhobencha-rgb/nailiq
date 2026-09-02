import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260902023503_turniq_redo_repair_policy_boundary.sql",
  ),
  "utf8",
);

describe("TurnIQ M3H2 redo / repair boundary", () => {
  it("uses immutable per-policy category rules without browser-supplied outcomes", () => {
    expect(sql).toContain("CREATE TABLE public.turniq_policy_redo_rules");
    expect(sql).toContain("consumes_turn boolean NOT NULL");
    expect(sql).toContain("credits_opportunity boolean NOT NULL");
    expect(sql).toContain("reject_turniq_redo_rule_mutation");
    expect(sql).not.toMatch(/p_(?:consumes_turn|credits_opportunity)\s+boolean/i);
  });

  it("links a new assignment to a completed original and never rewrites the original", () => {
    expect(sql).toContain("redo_original_assignment_id");
    expect(sql).toMatch(/v_original\.status <> 'completed'/);
    expect(sql).toMatch(/UPDATE public\.turniq_assignments AS a[\s\S]+WHERE a\.id = p_assignment_id/);
    expect(sql).not.toMatch(/UPDATE public\.turniq_assignments[\s\S]+WHERE[^;]+p_original_assignment_id/);
  });

  it("fails closed with an owner exception when the active policy has no category rule", () => {
    expect(sql).toContain("redo_policy_missing");
    expect(sql).toContain("policy_configuration_required");
    expect(sql).toMatch(/IF NOT FOUND THEN[\s\S]+INSERT INTO public\.turniq_exceptions/);
    expect(sql).toMatch(/OLD\.status = 'recommended'[\s\S]+NEW\.status = 'confirmed'[\s\S]+redo_policy_missing/);
  });

  it("applies turn and opportunity credit independently in one completion transaction", () => {
    expect(sql).toMatch(/turn_consumed = v_consumes_turn/);
    expect(sql).toMatch(/CASE WHEN v_consumes_turn THEN 1 ELSE 0 END/);
    expect(sql).toMatch(/CASE WHEN v_credits_opportunity[\s\S]+opportunity_credit_cents ELSE 0 END/);
    expect(sql).toMatch(/UPDATE public\.bookings[\s\S]+UPDATE public\.turniq_assignments[\s\S]+UPDATE public\.turniq_shift_sessions[\s\S]+turniq_store_online_command[\s\S]+INSERT INTO public\.turniq_events/);
  });

  it("blocks the legacy completion path and exposes RPCs only to service_role", () => {
    expect(sql).toContain("guard_turniq_redo_completion_path");
    expect(sql).not.toMatch(/SECURITY DEFINER/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.apply_turniq_redo_classification_v1[\s\S]+FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.complete_turniq_assignment_command_v2[\s\S]+TO service_role/);
  });
});
