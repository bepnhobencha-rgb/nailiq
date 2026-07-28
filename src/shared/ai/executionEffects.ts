import type { ExecutionJobRow } from "@/shared/ai/executionQueue";

export type ExecutionEffect =
  | {
      kind: "internal_audit";
      actionType: "approved_operational_note";
      payload: Record<string, unknown>;
    }
  | {
      kind: "waiting_input";
      blocker: "recipient_selection_required";
    }
  | {
      kind: "unsupported";
      reason: "unsupported_action_type" | "invalid_operational_note";
    };

/**
 * Explicit allowlist for execution effects.
 *
 * Outbound action types are intentionally blocked here. Adding an SMS, email,
 * payment, booking mutation, or other external effect requires its own handler
 * with consent, idempotency, and rollback evidence.
 */
export function planExecutionEffect(job: ExecutionJobRow): ExecutionEffect {
  if (job.action_type === "bulk_message") {
    return {
      kind: "waiting_input",
      blocker: "recipient_selection_required",
    };
  }

  if (job.action_type === "record_operational_note") {
    const note =
      typeof job.payload.note === "string" ? job.payload.note.trim() : "";
    if (!note || note.length > 1000) {
      return { kind: "unsupported", reason: "invalid_operational_note" };
    }
    return {
      kind: "internal_audit",
      actionType: "approved_operational_note",
      payload: {
        execution_job_id: job.id,
        approval_request_id: job.approval_request_id,
        note,
      },
    };
  }

  return { kind: "unsupported", reason: "unsupported_action_type" };
}
