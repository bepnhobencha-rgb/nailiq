import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260727220000_add_ai_execution_worker_heartbeat.sql",
  ),
  "utf8",
);
const heartbeatSource = readFileSync(
  resolve(process.cwd(), "src/shared/ai/executionHeartbeat.ts"),
  "utf8",
);
const routeSource = readFileSync(
  resolve(process.cwd(), "src/app/api/cron/ai-execution/route.ts"),
  "utf8",
);

describe("AI execution worker heartbeat boundary", () => {
  it("keeps heartbeat state and its writer service-role-only", () => {
    expect(migration).toContain(
      "alter table public.ai_execution_worker_state enable row level security",
    );
    expect(migration).toMatch(
      /revoke all on table public\.ai_execution_worker_state\s+from public, anon, authenticated/,
    );
    expect(migration).toMatch(
      /revoke all on function public\.record_ai_execution_worker_heartbeat\([\s\S]*?from public, anon, authenticated/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.record_ai_execution_worker_heartbeat\([\s\S]*?to service_role/,
    );
  });

  it("fences completion with the current run id", () => {
    expect(migration).toContain("and run_id = p_run_id");
    expect(migration).toContain("return found");
    expect(heartbeatSource).toContain('if (data !== true)');
    expect(heartbeatSource).toContain("stale_execution_heartbeat");
  });

  it("records start before work and both terminal outcomes", () => {
    const started = routeSource.indexOf('phase: "started"');
    const work = routeSource.indexOf(
      "await processExecutionQueue({ limit: 10 })",
    );
    const succeeded = routeSource.indexOf('phase: "succeeded"');
    const failed = routeSource.indexOf('phase: "failed"');
    expect(started).toBeGreaterThan(-1);
    expect(started).toBeLessThan(work);
    expect(succeeded).toBeGreaterThan(work);
    expect(failed).toBeGreaterThan(work);
  });

  it("adds no messaging, payment, or booking mutation authority", () => {
    expect(heartbeatSource).not.toMatch(
      /\b(sendSms|sendEmail|charge|refund|bookings)\s*\(/,
    );
    expect(routeSource).not.toMatch(/sendSms|sendEmail|charge|refund/);
  });
});
