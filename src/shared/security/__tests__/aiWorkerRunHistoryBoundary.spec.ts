import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260728050000_add_ai_worker_run_history.sql",
  ),
  "utf8",
);

describe("AI worker run history boundary", () => {
  it("keeps scheduler history service-role-only", () => {
    expect(migration).toContain(
      "alter table public.ai_worker_runs enable row level security",
    );
    expect(migration).toMatch(
      /revoke all on table public\.ai_worker_runs\s+from public, anon, authenticated/,
    );
    expect(migration).toMatch(
      /grant select, insert, update on table public\.ai_worker_runs\s+to service_role/,
    );
  });

  it("records only known workers and valid lifecycle states", () => {
    expect(migration).toContain(
      "check (worker_name in ('ai_execution', 'ai_manager'))",
    );
    expect(migration).toContain(
      "check (status in ('running', 'succeeded', 'failed'))",
    );
    expect(migration).toContain(
      "ai_worker_runs_terminal_shape_check",
    );
  });

  it("persists starts before terminal outcomes and preserves current-run fencing", () => {
    expect(migration).toContain("insert into public.ai_worker_runs");
    expect(migration).toContain("update public.ai_worker_runs");
    expect(migration).toContain("and run_id = p_run_id");
    expect(migration).toContain("return history_updated and current_updated");
  });

  it("bounds stored error categories and adds no operational authority", () => {
    expect(migration).toContain(
      "p_error ~ '^[a-z0-9_:-]{1,120}$'",
    );
    expect(migration).toContain("then 'worker_failed'");
    expect(migration).not.toMatch(
      /sendSms|sendEmail|charge|refund|from public\.bookings|auth\./,
    );
  });
});
