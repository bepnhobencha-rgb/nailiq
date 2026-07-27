import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

describe("AI execution worker boundary", () => {
  const effects = read("src/shared/ai/executionEffects.ts");
  const worker = read("src/shared/ai/executionWorker.ts");
  const route = read("src/app/api/cron/ai-execution/route.ts");
  const schedule = read("vercel.json");

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

  it("claims optimistically and bounds retry attempts", () => {
    expect(worker).toContain('.eq("status" as never, candidate.status)');
    expect(worker).toContain(
      '.eq("attempt_count" as never, candidate.attempt_count)',
    );
    expect(worker).toContain("canRetryExecution");
    expect(worker).toContain("nextRetryAt");
    expect(worker).toContain("attempt_count: attemptCount");
    expect(worker).toContain('"worker_lease_expired"');
    expect(worker).toContain("15 * 60_000");
  });

  it("records terminal and retry transitions in the AI audit log", () => {
    expect(worker).toContain('.from("ai_actions_log" as never)');
    expect(worker).toContain('agent: "ai_execution"');
    expect(worker).toContain('status: "succeeded"');
    expect(worker).toContain('status: "failed"');
    expect(worker).toContain('status: "canceled"');
    expect(worker).toContain('status: "waiting_input"');
  });

  it("requires a configured cron secret and is scheduled", () => {
    expect(route).toContain('"cron_secret_not_configured"');
    expect(route).toContain("`Bearer ${cronSecret}`");
    expect(schedule).toContain('"/api/cron/ai-execution"');
    expect(schedule).toContain('"*/5 * * * *"');
  });
});
