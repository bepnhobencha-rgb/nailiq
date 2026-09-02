import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260902030008_turniq_consented_swap_correction_history.sql",
  ),
  "utf8",
);

describe("TurnIQ M3H3 consented swap and correction boundary", () => {
  it("requires two append-only technician consents plus desk confirmation", () => {
    expect(sql).toContain("CREATE TABLE public.turniq_assignment_swaps");
    expect(sql).toContain("CREATE TABLE public.turniq_swap_consents");
    expect(sql).toContain("only an affected technician may consent to this swap");
    expect(sql).toMatch(/count\(\*\)[\s\S]+decision = 'accepted'[\s\S]+<> 2/);
    expect(sql).toContain("TurnIQ swap requires two consents and desk confirmation");
  });

  it("permits only a confirmed pre-service transfer and blocks start while pending", () => {
    expect(sql).toMatch(/v_assignment\.status <> 'confirmed'/);
    expect(sql).toMatch(/v_assignment\.started_at IS NOT NULL/);
    expect(sql).toContain("guard_turniq_pending_swap_start");
    expect(sql).toMatch(/UPDATE public\.bookings AS b[\s\S]+UPDATE public\.turniq_assignments AS a/);
  });

  it("moves completed turn and credit atomically while preserving the receipt", () => {
    expect(sql).toContain("CREATE TABLE public.turniq_assignment_corrections");
    expect(sql).toMatch(/turns_consumed = sh\.turns_consumed - v_turn_delta/);
    expect(sql).toMatch(/turns_consumed = sh\.turns_consumed \+ v_turn_delta/);
    expect(sql).toMatch(/service_credit_since_checkin_cents - v_credit_delta/);
    expect(sql).toMatch(/service_credit_since_checkin_cents \+ v_credit_delta/);
    expect(sql).not.toMatch(/UPDATE public\.turniq_fairness_receipts/i);
  });

  it("keeps browser roles out and uses invoker-only RPCs", () => {
    expect(sql).not.toMatch(/SECURITY DEFINER/i);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.turniq_assignment_swaps[\s\S]+FROM PUBLIC, anon, authenticated, service_role/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.apply_turniq_swap_command_v1[\s\S]+FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.apply_turniq_assignment_correction_v1[\s\S]+TO service_role/);
  });
});
