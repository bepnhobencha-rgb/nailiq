"use server";

import { revalidatePath } from "next/cache";

import {
  parseDeskAfterHoursApprovalPayload,
} from "@/shared/dashboard/deskAfterHoursApproval";
import { DESK_AFTER_HOURS_APPROVAL_ACTION } from "@/shared/dashboard/deskAfterHoursApprovalContract";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

type ApprovalDecisionError =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "expired"
  | "already_declined"
  | "invalid_request"
  | "server_error"
  | "time_slot_taken"
  | "no_resource_available"
  | "staff_consent_required"
  | "outside_hours";

export type DecideDeskAfterHoursApprovalResult =
  | {
      ok: true;
      status: "approved" | "declined";
      bookingId?: string;
    }
  | { ok: false; error: ApprovalDecisionError };

function normalizeBookingError(error: string): ApprovalDecisionError {
  if (
    error === "time_slot_taken" ||
    error === "no_resource_available" ||
    error === "staff_consent_required" ||
    error === "outside_hours"
  ) {
    return error;
  }
  return "server_error";
}

export async function decideDeskAfterHoursApprovalAction(input: {
  slug: string;
  approvalId: string;
  decision: "approved" | "declined";
}): Promise<DecideDeskAfterHoursApprovalResult> {
  const ctx = await getDashboardWriteClient(input.slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!ctx.userId || !isOwnerOrAdmin(ctx.role)) {
    return { ok: false, error: "forbidden" };
  }

  const db = createServiceRoleClient();
  const { data: request, error: requestError } = await db
    .from("approval_requests" as never)
    .select("id,salon_id,action_type,status,payload,expires_at")
    .eq("id" as never, input.approvalId)
    .eq("salon_id" as never, ctx.salon.id)
    .maybeSingle();
  const row = request as
    | {
        id: string;
        salon_id: string;
        action_type: string;
        status: string;
        payload: unknown;
        expires_at: string;
      }
    | null;
  if (requestError) return { ok: false, error: "server_error" };
  if (!row) return { ok: false, error: "not_found" };
  if (row.action_type !== DESK_AFTER_HOURS_APPROVAL_ACTION) {
    return { ok: false, error: "invalid_request" };
  }
  const payload = parseDeskAfterHoursApprovalPayload(row.payload);
  if (!payload || payload.booking.salonId !== ctx.salon.id) {
    return { ok: false, error: "invalid_request" };
  }

  if (input.decision === "declined" && row.status === "declined") {
    return { ok: true, status: "declined" };
  }
  if (input.decision === "approved" && row.status === "declined") {
    return { ok: false, error: "already_declined" };
  }

  if (row.status === "pending") {
    const { data: decisionData, error: decisionError } = await db.rpc(
      "decide_ai_approval_request_as_actor" as never,
      {
        p_approval_id: row.id,
        p_decision: input.decision,
        p_actor_user_id: ctx.userId,
      } as never,
    );
    if (decisionError) return { ok: false, error: "server_error" };
    const decisionRow = (Array.isArray(decisionData)
      ? decisionData[0]
      : decisionData) as { outcome?: unknown } | null;
    if (decisionRow?.outcome === "expired") {
      return { ok: false, error: "expired" };
    }
    const expected =
      input.decision === "approved" ? "approved_queued" : "declined";
    if (decisionRow?.outcome !== expected) {
      return { ok: false, error: "server_error" };
    }
  } else if (row.status !== input.decision) {
    return { ok: false, error: "server_error" };
  }

  if (input.decision === "declined") {
    revalidatePath(`/dashboard/${input.slug}/approvals`);
    return { ok: true, status: "declined" };
  }

  const { data: existingJob } = await db
    .from("ai_execution_jobs" as never)
    .select("id,status,result")
    .eq("approval_request_id" as never, row.id)
    .eq("salon_id" as never, ctx.salon.id)
    .maybeSingle();
  const job = existingJob as
    | { id: string; status: string; result: Record<string, unknown> | null }
    | null;
  if (job?.status === "succeeded" && typeof job.result?.booking_id === "string") {
    return {
      ok: true,
      status: "approved",
      bookingId: job.result.booking_id,
    };
  }

  // Dynamic import avoids a module cycle: the booking action uses the request
  // creator, while this owner-only action reuses the full authoritative create
  // path after approval instead of duplicating its safety checks.
  const { addDeskAppointment } = await import(
    "@/shared/dashboard/receptionistActions"
  );
  const booking = await addDeskAppointment(input.slug, payload.booking);
  if (!booking.ok) {
    if (job?.id) {
      await db
        .from("ai_execution_jobs" as never)
        .update({
          status: "waiting_input",
          result: {
            blocker: "after_hours_booking_retry_required",
            booking_error: booking.error,
          },
          last_error: null,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("id" as never, job.id)
        .eq("status" as never, "waiting_input");
    }
    return { ok: false, error: normalizeBookingError(booking.error) };
  }
  if (booking.approvalPending) {
    return { ok: false, error: "server_error" };
  }

  if (job?.id) {
    const finishedAt = new Date().toISOString();
    const { error: finishError } = await db
      .from("ai_execution_jobs" as never)
      .update({
        status: "succeeded",
        result: {
          booking_id: booking.bookingId,
          effect: "desk_after_hours_booking_created",
        },
        last_error: null,
        finished_at: finishedAt,
        updated_at: finishedAt,
      } as never)
      .eq("id" as never, job.id)
      .eq("status" as never, "waiting_input");
    if (finishError) {
      // The booking is already authoritative. Never turn a committed booking
      // into a false failure that encourages a duplicate retry.
      console.error(
        "[decideDeskAfterHoursApprovalAction] booking committed; job receipt pending",
        finishError,
      );
    }
  }

  revalidatePath(`/dashboard/${input.slug}/approvals`);
  revalidatePath(`/dashboard/${input.slug}/center`);
  return {
    ok: true,
    status: "approved",
    bookingId: booking.bookingId,
  };
}
