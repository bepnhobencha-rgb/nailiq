import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

describe("AI execution worker boundary", () => {
  const effects = read("src/shared/ai/executionEffects.ts");
  const worker = read("src/shared/ai/executionWorker.ts");
  const leases = read(
    "supabase/migrations/20260727203000_add_ai_execution_leases.sql",
  );
  const route = read("src/app/api/cron/ai-execution/route.ts");
  const authorization = read(
    "src/shared/security/cronAuthorization.ts",
  );
  const schedule = read("vercel.json");
  const parity = read("scripts/check-schema-parity.ts");

  it("uses an explicit effect allowlist with outbound messaging blocked", () => {
    expect(effects).toContain('job.action_type === "bulk_message"');
    expect(effects).toContain('kind: "waiting_input"');
    expect(effects).toContain('job.action_type === "record_operational_note"');
    expect(effects).toContain('kind: "unsupported"');
    expect(effects).not.toContain("getTwilioClient");
    expect(effects).not.toContain("getResendClient");
    expect(worker).not.toContain("getTwilioClient");
    expect(worker).not.toContain("getResendClient");
  });

  it("claims with skip-locked leases and bounds retry attempts", () => {
    expect(worker).toContain('"claim_ai_execution_jobs" as never');
    expect(leases).toContain("for update skip locked");
    expect(leases).toContain("lease_token = gen_random_uuid()");
    expect(leases).toContain("attempt_count < max_attempts");
    expect(worker).toContain("nextRetryAt");
    expect(leases).toContain("'worker_lease_expired'");
    expect(leases).toContain("interval '15 minutes'");
  });

  it("atomically fences completion and its audit record", () => {
    expect(worker).toContain('"finish_ai_execution_job" as never');
    expect(worker).toContain("StaleExecutionLeaseError");
    expect(leases).toContain("and lease_token = p_lease_token");
    expect(leases).toContain("insert into public.ai_actions_log");
    expect(leases).toContain("'execution_' || p_status");
    expect(worker).toContain('status: "succeeded"');
    expect(worker).toContain('status: "failed"');
    expect(worker).toContain('status: "canceled"');
    expect(worker).toContain('status: "waiting_input"');
  });

  it("recovers expired leases atomically without letting old workers finish", () => {
    expect(worker).toContain('"recover_stale_ai_execution_jobs" as never');
    expect(leases).toContain("lease_token = null");
    expect(leases).toContain("lease_expires_at = null");
    expect(leases).toContain("'worker_lease_expired'");
    expect(leases).toContain("'execution_failed'");
  });

  it("requires a configured cron secret and is scheduled", () => {
    expect(route).toMatch(/requireCronAuthorization\(\w+\)/);
    expect(authorization).toContain('"cron_secret_not_configured"');
    expect(authorization).toContain("`Bearer ${expectedSecret}`");
    expect(schedule).toContain('"/api/cron/ai-execution"');
    expect(schedule).toContain('"*/5 * * * *"');
  });

  it("makes every lease RPC a blank-database critical object", () => {
    expect(parity).toContain("through 20260820105820");
    expect(parity).toContain("columns: 2640");
    expect(parity).toContain("functions: 389");
    expect(parity).toContain("indexes: 650");
    expect(parity).toContain('"claim_ai_execution_jobs"');
    expect(parity).toContain('"finish_ai_execution_job"');
    expect(parity).toContain('"recover_stale_ai_execution_jobs"');
  });
});
