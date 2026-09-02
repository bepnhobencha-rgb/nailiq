import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = join(
  process.cwd(),
  "supabase/migrations/20260901225714_add_turniq_atomic_online_commands.sql",
);
const sql = readFileSync(migrationPath, "utf8");

describe("TurnIQ M3A atomic online command boundary", () => {
  it("keeps the runtime behind the per-salon default-off flag", () => {
    expect(sql).toContain("turniq_trust_engine_enabled");
    expect(sql).toMatch(/feature_flags\s*->\s*'turniq_trust_engine_enabled'/);
    expect(sql).toContain("TurnIQ is not enabled for salon");
  });

  it("uses service-only invoker RPCs and never grants browser execution", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.apply_turniq_shift_command_v1");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.record_turniq_recommendation_v1");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION public.apply_turniq_assignment_command_v1");
    expect(sql).not.toMatch(/SECURITY DEFINER/i);
    expect(sql).not.toMatch(
      /GRANT EXECUTE[^;]+TO\s+(anon|authenticated)/i,
    );
    expect(sql).toMatch(/GRANT EXECUTE[^;]+TO service_role/);
  });

  it("verifies salon membership and narrows technician writes to own work", () => {
    expect(sql).toMatch(/FROM public\.salon_members m[\s\S]+m\.salon_id = p_salon_id[\s\S]+m\.user_id = p_actor_user_id/);
    expect(sql).toContain("Technician may change only own TurnIQ shift");
    expect(sql).toContain("Technician may start only own TurnIQ assignment");
    expect(sql).toContain("Technician may complete only own TurnIQ assignment");
    expect(sql).toContain("TurnIQ confirmation requires desk role");
  });

  it("serializes retries and writes command, event, and fairness evidence", () => {
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("turniq_replay_online_command");
    expect(sql).toContain("turniq_store_online_command");
    expect(sql).toContain("INSERT INTO public.turniq_events");
    expect(sql).toContain("INSERT INTO public.turniq_fairness_receipts");
    expect(sql).toContain("TurnIQ command idempotency conflict");
  });

  it("locks authoritative rows and advances booking lifecycle atomically", () => {
    expect(sql).toMatch(/FROM public\.turniq_assignments a[\s\S]+FOR UPDATE/);
    expect(sql).toMatch(/FROM public\.bookings b[\s\S]+FOR UPDATE/);
    expect(sql).toMatch(/FROM public\.turniq_shift_sessions sh[\s\S]+FOR UPDATE/);
    expect(sql).toContain("SET status = 'in_progress'");
    expect(sql).toContain("SET status = 'completed'");
    expect(sql).toContain("turns_consumed = sh.turns_consumed + 1");
  });

  it("does not install provider, notification, or live-table automation", () => {
    expect(sql).not.toMatch(/twilio|resend|square|stripe|fetch\s*\(/i);
    expect(sql).not.toMatch(/CREATE\s+TRIGGER[\s\S]+ON\s+public\.(bookings|staff|salon_resources)/i);
  });
});
