import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260902005103_turniq_business_day_shift_rollover.sql",
  ),
  "utf8",
);

describe("TurnIQ M3E business-day rollover boundary", () => {
  it("rolls only an earlier salon-local open shift inside the check-in transaction", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.apply_turniq_shift_command_v1");
    expect(sql).toMatch(/p_command_type = 'check_in'[\s\S]+v_shift\.business_date < v_business_date/);
    expect(sql).toContain("Technician already has an open TurnIQ shift");
    expect(sql).not.toMatch(/v_shift\.business_date <= v_business_date/);
  });

  it("closes the stale shift with optimistic versioning and an immutable event", () => {
    expect(sql).toContain("state_version = sh.state_version + 1");
    expect(sql).toContain("AND sh.state_version = v_shift.state_version");
    expect(sql).toContain("shift_business_day_closed");
    expect(sql).toContain("business_day_rollover");
    expect(sql).toMatch(/p_salon_id, v_shift\.policy_version_id, NULL, 'shift'/);
  });

  it("keeps the RPC invoker-only and unavailable to browser roles", () => {
    expect(sql).toContain("SECURITY INVOKER");
    expect(sql).not.toMatch(/SECURITY DEFINER/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]+FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION[\s\S]+TO service_role/);
    expect(sql).not.toMatch(/GRANT EXECUTE[^;]+TO\s+(anon|authenticated)/i);
  });

  it("does not call providers or mutate booking/payment tables", () => {
    expect(sql).not.toMatch(/twilio|resend|square|stripe|fetch\s*\(/i);
    expect(sql).not.toMatch(/UPDATE\s+public\.(bookings|payments|payment_ledger)/i);
  });
});
