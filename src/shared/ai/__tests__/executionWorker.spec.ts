import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/shared/lib/supabase/serviceRole", () => ({
  createServiceRoleClient: () => ({ rpc: mocks.rpc }),
}));

import { processExecutionQueue } from "@/shared/ai/executionWorker";
import type { ExecutionJobRow } from "@/shared/ai/executionQueue";

const NOW = new Date("2026-07-27T20:30:00.000Z");

function claimedJob(): ExecutionJobRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    salon_id: "22222222-2222-4222-8222-222222222222",
    approval_request_id: "33333333-3333-4333-8333-333333333333",
    action_type: "record_operational_note",
    payload: { note: "Review staffing" },
    status: "running",
    idempotency_key: "approval:33333333-3333-4333-8333-333333333333",
    attempt_count: 1,
    max_attempts: 3,
    available_at: NOW.toISOString(),
    started_at: NOW.toISOString(),
    finished_at: null,
    lease_token: "44444444-4444-4444-8444-444444444444",
    lease_expires_at: "2026-07-27T20:45:00.000Z",
    last_error: null,
    result: null,
    created_at: "2026-07-27T20:00:00.000Z",
    updated_at: NOW.toISOString(),
  };
}

describe("processExecutionQueue leases", () => {
  beforeEach(() => {
    mocks.rpc.mockReset();
  });

  it("executes the approved note atomically with the claimed lease", async () => {
    const job = claimedJob();
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "cancel_ineligible_ai_execution_jobs") {
        return { data: 0, error: null };
      }
      if (name === "recover_stale_ai_execution_jobs") {
        return { data: 0, error: null };
      }
      if (name === "claim_ai_execution_jobs") {
        return { data: [job], error: null };
      }
      if (name === "execute_ai_operational_note_v2") {
        return { data: "succeeded", error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const result = await processExecutionQueue({ now: NOW, limit: 10 });

    expect(result).toMatchObject({
      inspected: 1,
      recovered: 0,
      tenantCanceled: 0,
      claimed: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("execute_ai_operational_note_v2", {
      p_job_id: job.id,
      p_lease_token: job.lease_token,
      p_now: NOW.toISOString(),
    });
  });

  it("does not overwrite a newer attempt when its lease is stale", async () => {
    const job = claimedJob();
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "cancel_ineligible_ai_execution_jobs") {
        return { data: 0, error: null };
      }
      if (name === "recover_stale_ai_execution_jobs") {
        return { data: 0, error: null };
      }
      if (name === "claim_ai_execution_jobs") {
        return { data: [job], error: null };
      }
      return { data: false, error: null };
    });

    const result = await processExecutionQueue({ now: NOW });

    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.outcomes).toEqual([
      {
        jobId: job.id,
        status: "running",
        attempted: false,
        error: "stale_execution_lease",
      },
    ]);
    expect(
      mocks.rpc.mock.calls.filter(
        ([name]) => name === "execute_ai_operational_note_v2",
      ),
    ).toHaveLength(1);
  });

  it("records a bounded retry when finishing the effect fails transiently", async () => {
    const job = claimedJob();
    let finishCalls = 0;
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "cancel_ineligible_ai_execution_jobs") {
        return { data: 3, error: null };
      }
      if (name === "recover_stale_ai_execution_jobs") {
        return { data: 2, error: null };
      }
      if (name === "claim_ai_execution_jobs") {
        return { data: [job], error: null };
      }
      if (name === "execute_ai_operational_note_v2") {
        finishCalls++;
        return finishCalls === 1
          ? { data: null, error: { message: "temporary database error" } }
          : { data: "succeeded", error: null };
      }
      if (name === "finish_ai_execution_job") {
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const result = await processExecutionQueue({ now: NOW });

    expect(result.recovered).toBe(2);
    expect(result.tenantCanceled).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.outcomes[0]).toMatchObject({
      status: "failed",
      error: "execution_transient_failure",
    });
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "finish_ai_execution_job",
      expect.objectContaining({
        p_status: "failed",
        p_available_at: "2026-07-27T20:35:00.000Z",
        p_last_error: "execution_transient_failure",
        p_details: expect.objectContaining({
          error_code: "execution_transient_failure",
        }),
      }),
    );
    const finishInput = mocks.rpc.mock.calls.find(
      ([name]) => name === "finish_ai_execution_job",
    )?.[1];
    expect(JSON.stringify(finishInput)).not.toContain(
      "temporary database error",
    );
  });

  it("reports a tenant-state cancellation without retrying the job", async () => {
    const job = claimedJob();
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "cancel_ineligible_ai_execution_jobs") {
        return { data: 0, error: null };
      }
      if (name === "recover_stale_ai_execution_jobs") {
        return { data: 0, error: null };
      }
      if (name === "claim_ai_execution_jobs") {
        return { data: [job], error: null };
      }
      if (name === "execute_ai_operational_note_v2") {
        return { data: "canceled", error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const result = await processExecutionQueue({ now: NOW });

    expect(result).toMatchObject({
      claimed: 1,
      succeeded: 0,
      failed: 0,
      canceled: 1,
    });
    expect(result.outcomes).toEqual([
      {
        jobId: job.id,
        status: "canceled",
        attempted: false,
        error: "tenant_not_operational",
      },
    ]);
    expect(
      mocks.rpc.mock.calls.some(
        ([name]) => name === "finish_ai_execution_job",
      ),
    ).toBe(false);
  });
});
