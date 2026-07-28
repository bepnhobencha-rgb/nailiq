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
const atomicDecision = read(
  "supabase/migrations/20260727194500_make_approval_execution_atomic.sql",
);

describe("AI execution queue boundary", () => {
  it("is idempotent and records safe execution states", () => {
    expect(migration).toContain("unique (approval_request_id)");
    expect(migration).toContain("unique (salon_id, idempotency_key)");
    expect(migration).toContain("'waiting_input'");
    expect(migration).toContain("'running'");
    expect(migration).toContain("'succeeded'");
    expect(migration).toContain("'failed'");
    expect(atomicDecision).toContain("'approval:' || v_request.id::text");
    expect(atomicDecision).toContain(
      "on conflict (approval_request_id) do nothing",
    );
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

  it("persists approval, queue, and audit atomically", () => {
    expect(atomicDecision).toContain(
      "for update",
    );
    expect(atomicDecision).toContain(
      "update public.approval_requests",
    );
    expect(atomicDecision).toContain(
      "insert into public.ai_execution_jobs",
    );
    expect(atomicDecision).toContain(
      "insert into public.ai_actions_log",
    );
    expect(approval).toContain(
      '"decide_ai_approval_request" as never',
    );
    expect(queue).not.toContain("enqueueApprovedAction");
  });

  it("validates token intent, reconciles old approvals, and is service-role only", () => {
    expect(atomicDecision).toContain("ar.approve_token = p_token");
    expect(atomicDecision).toContain("ar.decline_token = p_token");
    expect(atomicDecision).toContain("'approved_recovered'");
    expect(atomicDecision).toContain(
      "revoke all on function public.decide_ai_approval_request(text, text)",
    );
    expect(atomicDecision).toContain("from public, anon, authenticated");
    expect(atomicDecision).toContain("to service_role");
  });

  it("updates the blank-database schema tripwire", () => {
    const parity = read("scripts/check-schema-parity.ts");
    expect(parity).toContain("tables: 92");
    expect(parity).toContain("columns: 1260");
    expect(parity).toContain("policies: 142");
    expect(parity).toContain("indexes: 305");
    expect(parity).toContain("functions: 83");
    expect(parity).toContain('"ai_execution_jobs"');
    expect(parity).toContain('"decide_ai_approval_request"');
    expect(parity).toContain(
      "const GRANTS = { anon: 57, authenticated: 61, service_role: 97 }",
    );
  });
});
