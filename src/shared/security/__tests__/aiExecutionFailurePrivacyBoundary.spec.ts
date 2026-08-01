import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const worker = read("src/shared/ai/executionWorker.ts");
const heartbeat = read("src/shared/ai/executionHeartbeat.ts");
const controlCenter = read("src/components/dashboard/AiControlCenter.tsx");
const approvals = read("src/components/dashboard/ApprovalsDashboard.tsx");

describe("AI execution failure privacy boundary", () => {
  it("persists only a safe code in both the job and audit payload", () => {
    expect(worker).toContain("lastError: safeError");
    expect(worker).toContain("error_code: safeError");
    expect(worker).not.toContain("lastError: message");
    expect(worker).not.toMatch(/details:\s*\{\s*error:/);
  });

  it("does not render stored failure text directly on owner surfaces", () => {
    expect(controlCenter).toContain(
      "executionFailureLabel(job.last_error, language)",
    );
    expect(approvals).toContain(
      'executionFailureLabel(job.last_error, "vi")',
    );
    expect(controlCenter).not.toMatch(/>\s*\{job\.last_error\}\s*</);
    expect(approvals).not.toMatch(/>\s*\{job\.last_error\}\s*</);
  });

  it("sanitizes heartbeat writes and masks historical heartbeat text", () => {
    expect(heartbeat).toContain("p_error: toSafeWorkerFailureCode(input.error)");
    expect(controlCenter).toContain(
      "workerFailureLabel(worker.lastError, language)",
    );
    expect(controlCenter).toContain(
      "workerFailureLabel(managerWorker.lastError, language)",
    );
    expect(controlCenter).not.toContain(
      '${worker.lastError}',
    );
    expect(controlCenter).not.toContain(
      '${managerWorker.lastError}',
    );
  });
});
