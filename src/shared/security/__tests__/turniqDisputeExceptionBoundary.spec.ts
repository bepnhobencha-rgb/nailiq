import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260902011857_turniq_dispute_exception_commands.sql",
  ),
  "utf8",
);

describe("TurnIQ M3F dispute and exception command boundary", () => {
  it("creates own-receipt disputes and links a quiet owner exception atomically", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.create_turniq_dispute_v1");
    expect(sql).toContain("Technician may dispute only own fairness receipt");
    expect(sql).toContain("'staff_dispute', 'open'");
    expect(sql).toContain("'dispute_opened'");
    expect(sql).toContain("'exception_opened'");
  });

  it("resolves disputes and linked exceptions only for owner or admin", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.resolve_turniq_dispute_v1");
    expect(sql).toContain("p_actor_role NOT IN ('owner', 'admin')");
    expect(sql).toContain("Staff dispute exception must use dispute resolution command");
    expect(sql).toMatch(/UPDATE public\.turniq_disputes[\s\S]+UPDATE public\.turniq_exceptions/);
    expect(sql).toContain("state_version = state_version + 1");
  });

  it("stores idempotent command receipts before immutable events", () => {
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("turniq_replay_online_command");
    expect(sql).toContain("turniq_store_online_command");
    expect(sql).toMatch(/turniq_store_online_command[\s\S]+INSERT INTO public\.turniq_events/);
  });

  it("keeps every RPC invoker-only and unavailable to browser roles", () => {
    expect(sql.match(/SECURITY INVOKER/g)).toHaveLength(3);
    expect(sql).not.toMatch(/SECURITY DEFINER/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.create_turniq_dispute_v1[\s\S]+FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.apply_turniq_exception_command_v1[\s\S]+TO service_role/);
    expect(sql).not.toMatch(/GRANT EXECUTE[^;]+TO\s+(anon|authenticated)/i);
  });

  it("does not call providers or mutate booking and payment truth", () => {
    expect(sql).not.toMatch(/twilio|resend|square|stripe|fetch\s*\(/i);
    expect(sql).not.toMatch(/(?:UPDATE|INSERT INTO)\s+public\.(bookings|payments|payment_ledger)/i);
  });
});
