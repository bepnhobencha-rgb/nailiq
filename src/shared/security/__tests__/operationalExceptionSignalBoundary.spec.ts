import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260728112951_add_ai_operational_exception_signals.sql",
);
const closureMigration = read(
  "supabase/migrations/20260728121000_close_canceled_ai_execution_exceptions.sql",
);
const manager = read("src/shared/ai/managerExceptionSignals.ts");
const route = read("src/app/api/cron/manager/route.ts");

describe("AI operational exception signal boundary", () => {
  it("serializes each salon/key and keeps the RPC service-role-only", () => {
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain(
      "p_salon_id::text || ':' || btrim(p_dedupe_key)",
    );
    expect(migration).toContain("security invoker");
    expect(migration).not.toContain("security definer");
    expect(migration).toMatch(
      /revoke all on function public\.record_ai_operational_exception_signal[\s\S]+from public, anon, authenticated/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.record_ai_operational_exception_signal[\s\S]+to service_role/,
    );
  });

  it("accepts only bounded signals without raw provider errors", () => {
    expect(migration).toContain("jsonb_array_length(p_signals) > 50");
    expect(migration).toContain("v_agent !~ '^[a-z][a-z0-9_]{0,49}$'");
    expect(migration).toContain("'raw_error_stored', false");
    expect(migration).not.toContain("last_error");
    expect(migration).not.toContain("p_error");
  });

  it("opens exhausted execution jobs and recovers them transactionally", () => {
    expect(migration).toContain(
      "create trigger sync_ai_execution_job_exception_trigger",
    );
    expect(migration).toContain("new.attempt_count >= new.max_attempts");
    expect(migration).toContain("'execution_job:' || new.id::text");
    expect(migration).toContain("new.status = 'succeeded'");
  });

  it("closes an exhausted incident when the owner cancels its execution", () => {
    expect(closureMigration).toContain("new.status = 'canceled'");
    expect(closureMigration).toContain(
      "dedupe_key = 'execution_job:' || new.id::text",
    );
    expect(closureMigration).toContain(
      "resolution_reason', 'owner_canceled_execution'",
    );
    expect(closureMigration).toContain(
      "Closed automatically after the owner canceled the execution job.",
    );
  });

  it("makes Manager exception sync part of fail-honest orchestration", () => {
    expect(manager).toContain(
      '"sync_ai_manager_operational_exceptions" as never',
    );
    expect(manager).toContain("p_salon_id: salonId");
    expect(route).toContain(
      "await syncManagerExceptionSignals(salon.id, entry)",
    );
    expect(route).toContain('entry.exception_sync = "failed"');
  });
});
