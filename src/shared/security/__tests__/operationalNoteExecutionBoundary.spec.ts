import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260728060000_execute_approved_operational_note.sql",
  ),
  "utf8",
);
const workerSource = readFileSync(
  resolve(process.cwd(), "src/shared/ai/executionWorker.ts"),
  "utf8",
);

describe("approved operational-note execution boundary", () => {
  it("requires the exact running job, lease, and allowlisted action", () => {
    expect(migration).toContain("and status = 'running'");
    expect(migration).toContain("and lease_token = p_lease_token");
    expect(migration).toContain(
      "and action_type = 'record_operational_note'",
    );
    expect(workerSource).toContain('"execute_ai_operational_note"');
  });

  it("makes the real effect and job success atomic and idempotent", () => {
    const effectInsert = migration.indexOf(
      "'approved_operational_note'",
    );
    const succeedJob = migration.indexOf(
      "set status = 'succeeded'",
    );
    expect(effectInsert).toBeGreaterThan(-1);
    expect(succeedJob).toBeGreaterThan(effectInsert);
    expect(migration).toContain(
      "ai_actions_log_execution_effect_once_idx",
    );
    expect(migration).toContain(
      "on conflict (agent, action_type, target_id)",
    );
  });

  it("bounds note content and keeps the executor service-role-only", () => {
    expect(migration).toContain("length(v_note) > 1000");
    expect(migration).toMatch(
      /revoke all on function public\.execute_ai_operational_note\([\s\S]*?from public, anon, authenticated/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.execute_ai_operational_note\([\s\S]*?to service_role/,
    );
  });

  it("adds no messaging, booking, payment, or authentication authority", () => {
    expect(migration).not.toMatch(
      /sendSms|sendEmail|charge|refund|from public\.bookings|update public\.bookings|auth\./,
    );
  });
});
