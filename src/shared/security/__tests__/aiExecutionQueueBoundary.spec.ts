import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(resolve(process.cwd(), file), "utf8");

const migration = read(
  "supabase/migrations/20260727082929_add_ai_execution_queue.sql",
);
const queue = read("src/shared/ai/executionQueue.ts");
const approval = read("src/shared/ai/approvalRequests.ts");

describe("AI execution queue boundary", () => {
  it("is idempotent and records safe execution states", () => {
    expect(migration).toContain("unique (approval_request_id)");
    expect(migration).toContain("unique (salon_id, idempotency_key)");
    expect(migration).toContain("'waiting_input'");
    expect(migration).toContain("'running'");
    expect(migration).toContain("'succeeded'");
    expect(migration).toContain("'failed'");
    expect(queue).toContain('onConflict: "approval_request_id"');
    expect(queue).toContain("ignoreDuplicates: true");
  });

  it("allows owners to read but only the service role to mutate", () => {
    expect(migration).toContain(
      "alter table public.ai_execution_jobs enable row level security",
    );
    expect(migration).toContain(
      "revoke all on table public.ai_execution_jobs from anon, authenticated",
    );
    expect(migration).toContain(
      "grant select on table public.ai_execution_jobs to authenticated",
    );
    expect(migration).toContain(
      "grant all on table public.ai_execution_jobs to service_role",
    );
    expect(migration).toContain("sm.role in ('owner', 'admin')");
    expect(queue).toContain("createServiceRoleClient");
  });

  it("queues only after an approval is persisted", () => {
    const approvalUpdate = approval.indexOf(
      "const { data: decidedRow, error: decisionError }",
    );
    const enqueue = approval.indexOf(
      "const queued = await enqueueApprovedAction",
    );
    expect(approvalUpdate).toBeGreaterThan(-1);
    expect(enqueue).toBeGreaterThan(approvalUpdate);
    expect(approval).toContain('.eq("status" as never, "pending")');
    expect(approval).toContain("if (decisionError)");
    expect(approval).toContain("if (!decidedRow)");
  });

  it("updates the blank-database schema tripwire", () => {
    const parity = read("scripts/check-schema-parity.ts");
    expect(parity).toContain("tables: 90");
    expect(parity).toContain("columns: 1238");
    expect(parity).toContain("policies: 142");
    expect(parity).toContain("indexes: 299");
    expect(parity).toContain('"ai_execution_jobs"');
    expect(parity).toContain(
      "const GRANTS = { anon: 57, authenticated: 61, service_role: 95 }",
    );
  });
});
