import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260902020118_turniq_why_not_me_skip_reviews.sql",
  ),
  "utf8",
);

describe("TurnIQ M3G Why not me boundary", () => {
  it("accepts only a technician found in the assignment's persisted skip trace", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.create_turniq_skip_dispute_v1");
    expect(sql).toContain("v_assignment.skipped_candidates");
    expect(sql).toContain("Technician may review only own persisted skip decision");
    expect(sql).toContain("'target_type', 'skip_decision'");
  });

  it("creates one active skip review and a quiet linked owner exception atomically", () => {
    expect(sql).toContain("turniq_dispute_one_active_skip_staff_idx");
    expect(sql).toContain("'staff_dispute', 'open'");
    expect(sql).toContain("'dispute_opened'");
    expect(sql).toContain("'exception_opened'");
    expect(sql).toMatch(/turniq_store_online_command[\s\S]+INSERT INTO public\.turniq_events/);
  });

  it("keeps the RPC invoker-only and unavailable to browser roles", () => {
    expect(sql).not.toMatch(/SECURITY DEFINER/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.create_turniq_skip_dispute_v1[\s\S]+FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.create_turniq_skip_dispute_v1[\s\S]+TO service_role/);
    expect(sql).not.toMatch(/GRANT EXECUTE[^;]+TO\s+(anon|authenticated)/i);
  });

  it("does not mutate queue, assignment, booking, payment, or provider truth", () => {
    expect(sql).not.toMatch(/twilio|resend|square|stripe|fetch\s*\(/i);
    expect(sql).not.toMatch(/(?:UPDATE|INSERT INTO)\s+public\.(bookings|payments|payment_ledger|turniq_assignments|turniq_shift_sessions)/i);
  });
});
