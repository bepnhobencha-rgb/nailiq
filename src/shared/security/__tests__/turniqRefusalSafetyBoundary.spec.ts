import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260902021809_turniq_refusal_safety_boundary.sql",
  ),
  "utf8",
);

describe("TurnIQ M3H1 refusal safety boundary", () => {
  it("derives three explicit policy outcomes without a generic no-penalty escape", () => {
    expect(sql).toContain("'customer_declined', 'illness_emergency', 'unapproved_refusal'");
    expect(sql).toContain("'no_penalty', 'no_penalty_temporary_hold', 'moved_to_queue_end'");
    expect(sql).toContain("v_policy.refusal_policy <> 'move_to_end_unless_approved'");
    expect(sql).not.toMatch(/p_(?:approved|penalty|outcome)\s+(?:boolean|text)/i);
  });

  it("moves only unapproved refusal to the queue end and preserves emergency position", () => {
    expect(sql).toMatch(/p_refusal_category = 'illness_emergency'[\s\S]+state = 'temporary_hold'/);
    expect(sql).toMatch(/ELSE[\s\S]+max\(sh\.queue_position\)[\s\S]+queue_position = v_queue_position/);
    expect(sql).toContain("customer_declined_recommendation");
    expect(sql).toContain("shift_moved_to_queue_end_after_refusal");
  });

  it("keeps booking/provider truth untouched and records refusal atomically", () => {
    expect(sql).not.toMatch(/(?:UPDATE|INSERT INTO)\s+public\.(bookings|payments|payment_ledger)/i);
    expect(sql).not.toMatch(/twilio|resend|square|stripe|fetch\s*\(/i);
    expect(sql).toMatch(/UPDATE public\.turniq_assignments[\s\S]+turniq_store_online_command[\s\S]+INSERT INTO public\.turniq_events/);
  });

  it("is invoker-only, desk-classified and unavailable to browser roles", () => {
    expect(sql).not.toMatch(/SECURITY DEFINER/i);
    expect(sql).toContain("p_actor_role NOT IN ('owner', 'admin', 'senior', 'receptionist')");
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.apply_turniq_refusal_command_v1[\s\S]+FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.apply_turniq_refusal_command_v1[\s\S]+TO service_role/);
  });
});
