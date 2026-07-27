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

  it("finishes only with the fencing token returned by the atomic claim", async () => {
    const job = claimedJob();
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "recover_stale_ai_execution_jobs") {
        return { data: 0, error: null };
      }
      if (name === "claim_ai_execution_jobs") {
        return { data: [job], error: null };
      }
      if (name === "finish_ai_execution_job") {
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });

    const result = await processExecutionQueue({ now: NOW, limit: 10 });

    expect(result).toMatchObject({
      inspected: 1,
      recovered: 0,
      claimed: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("finish_ai_execution_job", {
      p_job_id: job.id,
      p_lease_token: job.lease_token,
      p_status: "succeeded",
      p_result: expect.objectContaining({
        effect: "internal_audit",
        note: "Review staffing",
      }),
      p_last_error: null,
      p_available_at: null,
      p_finished_at: NOW.toISOString(),
      p_now: NOW.toISOString(),
      p_details: expect.objectContaining({
        effect: "internal_audit",
        note: "Review staffing",
      }),
    });
  });

  it("does not overwrite a newer attempt when its lease is stale", async () => {
    const job = claimedJob();
    mocks.rpc.mockImplementation(async (name: string) => {
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
      mocks.rpc.mock.calls.filter(([name]) => name === "finish_ai_execution_job"),
    ).toHaveLength(1);
  });

  it("records a bounded retry when finishing the effect fails transiently", async () => {
    const job = claimedJob();
    let finishCalls = 0;
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "recover_stale_ai_execution_jobs") {
        return { data: 2, error: null };
      }
      if (name === "claim_ai_execution_jobs") {
        return { data: [job], error: null };
      }
      finishCalls++;
      return finishCalls === 1
        ? { data: null, error: { message: "temporary database error" } }
        : { data: true, error: null };
    });

    const result = await processExecutionQueue({ now: NOW });

    expect(result.recovered).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.outcomes[0]).toMatchObject({
      status: "failed",
      error: "temporary database error",
    });
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "finish_ai_execution_job",
      expect.objectContaining({
        p_status: "failed",
        p_available_at: "2026-07-27T20:35:00.000Z",
        p_last_error: "temporary database error",
      }),
    );
  });
});
