import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const action = readFileSync(
  resolve(process.cwd(), "src/shared/ai/controlExecutionJobAction.ts"),
  "utf8",
);
const migration = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260727183101_add_ai_execution_job_control.sql",
  ),
  "utf8",
);
const parityCheck = readFileSync(
  resolve(process.cwd(), "scripts/check-schema-parity.ts"),
  "utf8",
);

describe("AI execution control boundary", () => {
  it("requires a resolved owner/admin and passes the resolved salon scope", () => {
    expect(action).toContain("getDashboardWriteClient(input.slug)");
    expect(action).toContain("isOwnerOrAdmin(ctx.role)");
    expect(action).toContain("p_salon_id: ctx.salon.id");
    expect(action).toContain("p_actor_user_id: ctx.userId");
  });

  it("keeps the mutation RPC service-role only", () => {
    expect(migration).toContain("security invoker");
    expect(migration).toContain("set search_path = ''");
    expect(migration).toMatch(
      /revoke all on function public\.control_ai_execution_job\(uuid, uuid, text, uuid\)\s+from public, anon, authenticated/i,
    );
    expect(migration).toMatch(
      /grant execute on function public\.control_ai_execution_job\(uuid, uuid, text, uuid\)\s+to service_role/i,
    );
  });

  it("locks a tenant-scoped row and audits in the same function", () => {
    expect(migration).toContain("and salon_id = p_salon_id");
    expect(migration).toContain("for update");
    expect(migration).toContain("insert into public.ai_actions_log");
    expect(migration).toContain("'actor_user_id', p_actor_user_id");
  });

  it("never retries exhausted work or cancels running/terminal work", () => {
    expect(migration).toContain(
      "v_job.status <> 'failed' or v_job.attempt_count >= v_job.max_attempts",
    );
    expect(migration).toContain(
      "v_job.status not in ('queued', 'waiting_input', 'failed')",
    );
  });

  it("makes the recovery RPC a production-parity critical object", () => {
    expect(parityCheck).toContain("functions: 78");
    expect(parityCheck).toContain('"control_ai_execution_job"');
  });
});
