import { describe, expect, it } from "vitest";
import { planExecutionEffect } from "@/shared/ai/executionEffects";
import type { ExecutionJobRow } from "@/shared/ai/executionQueue";

function job(
  actionType: string,
  payload: Record<string, unknown> = {},
): ExecutionJobRow {
  return {
    id: "job-1",
    salon_id: "salon-1",
    approval_request_id: "approval-1",
    action_type: actionType,
    payload,
    status: "running",
    idempotency_key: "approval:approval-1",
    attempt_count: 1,
    max_attempts: 3,
    available_at: "2026-07-27T00:00:00.000Z",
    started_at: "2026-07-27T00:00:00.000Z",
    finished_at: null,
    last_error: null,
    result: null,
    created_at: "2026-07-27T00:00:00.000Z",
    updated_at: "2026-07-27T00:00:00.000Z",
  };
}

describe("execution effect allowlist", () => {
  it("blocks bulk messaging until recipient and consent inputs exist", () => {
    expect(planExecutionEffect(job("bulk_message"))).toEqual({
      kind: "waiting_input",
      blocker: "recipient_selection_required",
    });
  });

  it("allows only an internal operational-note audit effect", () => {
    expect(
      planExecutionEffect(job("record_operational_note", { note: "Review staffing" })),
    ).toEqual({
      kind: "internal_audit",
      actionType: "approved_operational_note",
      payload: {
        execution_job_id: "job-1",
        approval_request_id: "approval-1",
        note: "Review staffing",
      },
    });
  });

  it("cancels unsupported action types instead of guessing an effect", () => {
    expect(planExecutionEffect(job("charge_card"))).toEqual({
      kind: "unsupported",
      reason: "unsupported_action_type",
    });
  });
});
