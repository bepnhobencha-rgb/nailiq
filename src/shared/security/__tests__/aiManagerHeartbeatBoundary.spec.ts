import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260728040000_add_ai_manager_worker_heartbeat.sql",
  ),
  "utf8",
);
const routeSource = readFileSync(
  resolve(process.cwd(), "src/app/api/cron/manager/route.ts"),
  "utf8",
);
const summarySource = readFileSync(
  resolve(process.cwd(), "src/shared/ai/managerRunSummary.ts"),
  "utf8",
);

describe("AI Manager worker heartbeat boundary", () => {
  it("allows only known workers and keeps the generic writer service-role-only", () => {
    expect(migration).toContain(
      "check (worker_name in ('ai_execution', 'ai_manager'))",
    );
    expect(migration).toMatch(
      /revoke all on function public\.record_ai_worker_heartbeat\([\s\S]*?from public, anon, authenticated/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.record_ai_worker_heartbeat\([\s\S]*?to service_role/,
    );
  });

  it("retains run fencing and the existing execution-worker contract", () => {
    expect(migration).toContain("and run_id = p_run_id");
    expect(migration).toContain(
      "create or replace function public.record_ai_execution_worker_heartbeat",
    );
    expect(migration).toContain(
      "select public.record_ai_worker_heartbeat(",
    );
  });

  it("records the manager start before loading salons and fails closed", () => {
    const started = routeSource.indexOf('phase: "started"');
    const loadSalons = routeSource.indexOf(
      'const supabase = createServiceRoleClient()',
    );
    expect(started).toBeGreaterThan(-1);
    expect(started).toBeLessThan(loadSalons);
    expect(routeSource).toContain("cron_secret_not_configured");
    expect(routeSource).toContain("manager_heartbeat_unavailable");
  });

  it("persists only bounded agent identities, not raw error bodies", () => {
    expect(summarySource).toContain("failedAgents.slice(0, 100)");
    expect(summarySource).toContain("`${salon}:${agent}`");
    expect(summarySource).not.toContain("String(outcome)");
  });

  it("adds no messaging, payment, booking, or authentication authority", () => {
    expect(migration).not.toMatch(/sendSms|sendEmail|charge|refund|bookings/);
    expect(summarySource).not.toMatch(
      /sendSms|sendEmail|charge|refund|bookings|auth/,
    );
  });
});
