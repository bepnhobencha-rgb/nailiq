import "server-only";

import type { ExecutionJobRow } from "@/shared/ai/executionQueue";
import { createApprovalRequest } from "@/shared/ai/approvalRequests";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { notifyWaitlistForSlot } from "@/shared/noshow/waitlistAutoFill";
import { salonYmdOfUtc } from "@/shared/lib/salonTime";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type BookingContext = {
  id: string;
  salon_id: string;
  service_id: string;
  staff_id: string | null;
  status: string;
  start_time_utc: string;
  end_time_utc: string;
};

/**
 * Feature-gated owner approval for a single freed appointment slot.
 *
 * The legacy waitlist auto-fill remains the default. When
 * `ai_cancellation_autofill_approval` is enabled, a desk cancellation creates
 * one short-lived approval instead of contacting a customer immediately.
 */
export async function createCancellationAutofillApproval(input: {
  salonId: string;
  bookingId: string;
}): Promise<{ handled: boolean; approvalId: string | null }> {
  const db = createServiceRoleClient();
  const [salonResult, bookingResult] = await Promise.all([
    db.from("salons" as never)
      .select("name,timezone,feature_flags" as never)
      .eq("id" as never, input.salonId)
      .maybeSingle(),
    db.from("bookings" as never)
      .select("id,salon_id,service_id,staff_id,status,start_time_utc,end_time_utc" as never)
      .eq("id" as never, input.bookingId)
      .eq("salon_id" as never, input.salonId)
      .maybeSingle(),
  ]);
  if (salonResult.error) throw salonResult.error;
  if (bookingResult.error) throw bookingResult.error;
  const salon = salonResult.data;
  const booking = bookingResult.data;
  const salonRow = salon as {
    name?: string | null;
    timezone?: string | null;
    feature_flags?: Record<string, unknown> | null;
  } | null;
  if (salonRow?.feature_flags?.ai_cancellation_autofill_approval !== true) {
    return { handled: false, approvalId: null };
  }
  const bookingRow = booking as BookingContext | null;
  if (!bookingRow?.service_id || bookingRow.status !== "cancelled") {
    return { handled: true, approvalId: null };
  }

  const bookingDate = salonYmdOfUtc(
    bookingRow.start_time_utc,
    salonRow.timezone?.trim() || "America/Los_Angeles",
  );
  const { count, error: waitlistError } = await db.from("booking_waitlist_entries" as never)
    .select("id" as never, { count: "exact", head: true })
    .eq("salon_id" as never, input.salonId)
    .eq("service_id" as never, bookingRow.service_id)
    .eq("booking_date" as never, bookingDate)
    .eq("status" as never, "waiting");
  if (waitlistError) throw waitlistError;
  if (!count) return { handled: true, approvalId: null };

  const { data: existing, error: existingError } = await db.from("approval_requests" as never)
    .select("id" as never)
    .eq("salon_id" as never, input.salonId)
    .eq("action_type" as never, "waitlist_invite")
    .eq("status" as never, "pending")
    .contains("payload" as never, { booking_id: input.bookingId } as never)
    .limit(1)
    .maybeSingle();
  if (existingError) throw existingError;
  const existingRow = existing as unknown as { id?: string } | null;
  if (existingRow?.id) {
    return { handled: true, approvalId: existingRow.id };
  }

  const when = new Intl.DateTimeFormat("en-CA", {
    timeZone: salonRow.timezone?.trim() || "America/Los_Angeles",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(bookingRow.start_time_utc));
  const approvalId = await createApprovalRequest({
    salonId: input.salonId,
    actionType: "waitlist_invite",
    summary: `A slot opened at ${salonRow.name ?? "the salon"} on ${when}. Invite the first matching waitlist customer?`,
    urgency: "urgent",
    expiresInHours: 4,
    payload: {
      booking_id: input.bookingId,
      reason: "A confirmed appointment was cancelled and a matching customer is waiting.",
      evidence: [`${count} matching waitlist customer${count === 1 ? "" : "s"}`],
      expected_impact: "Recover the freed appointment without contacting anyone until the owner approves.",
      confidence: 1,
      reversible: false,
    },
  });
  return { handled: true, approvalId };
}

export async function executeApprovedWaitlistInvite(
  job: ExecutionJobRow,
): Promise<Record<string, unknown>> {
  const bookingId = typeof job.payload.booking_id === "string"
    ? job.payload.booking_id.trim()
    : "";
  if (!UUID_RE.test(bookingId)) throw new Error("invalid_waitlist_invite_booking");
  const db = createServiceRoleClient();

  const { data: prior, error: priorError } = await db.from("ai_actions_log" as never)
    .select("id,payload" as never)
    .eq("salon_id" as never, job.salon_id)
    .eq("agent" as never, "cancellation_radar")
    .eq("action_type" as never, "cancellation_autofill_invite")
    .eq("target_id" as never, bookingId)
    .limit(1)
    .maybeSingle();
  if (priorError) throw priorError;
  if (prior) return { outcome: "already_handled" };

  const { data: booking, error: bookingError } = await db.from("bookings" as never)
    .select("id,salon_id,service_id,staff_id,status,start_time_utc,end_time_utc" as never)
    .eq("id" as never, bookingId)
    .eq("salon_id" as never, job.salon_id)
    .maybeSingle();
  if (bookingError) throw bookingError;
  const row = booking as BookingContext | null;
  if (!row || row.status !== "cancelled" || !row.service_id) {
    return { outcome: "slot_ineligible" };
  }

  if (row.staff_id) {
    const { count: conflicts, error: conflictError } = await db.from("bookings" as never)
      .select("id" as never, { count: "exact", head: true })
      .eq("salon_id" as never, job.salon_id)
      .eq("staff_id" as never, row.staff_id)
      .neq("id" as never, bookingId)
      .in("status" as never, ["pending", "confirmed", "in_progress"])
      .lt("start_time_utc" as never, row.end_time_utc)
      .gt("end_time_utc" as never, row.start_time_utc);
    if (conflictError) throw conflictError;
    if (conflicts) return { outcome: "slot_filled" };
  }

  const [salonResult, serviceResult] = await Promise.all([
    db.from("salons" as never).select("name,timezone" as never)
      .eq("id" as never, job.salon_id).maybeSingle(),
    db.from("services" as never).select("name" as never)
      .eq("id" as never, row.service_id).maybeSingle(),
  ]);
  if (salonResult.error) throw salonResult.error;
  if (serviceResult.error) throw serviceResult.error;
  const salon = salonResult.data;
  const service = serviceResult.data;
  const salonRow = salon as { name?: string | null; timezone?: string | null } | null;
  const serviceRow = service as { name?: string | null } | null;
  const bookingDate = salonYmdOfUtc(
    row.start_time_utc,
    salonRow?.timezone?.trim() || "America/Los_Angeles",
  );
  const { data: promoted, error: promotedError } = await db.rpc("notify_waitlist_for_no_show" as never, {
    p_booking_id: bookingId,
  } as never);
  if (promotedError) throw promotedError;
  const promotedRow = Array.isArray(promoted) ? promoted[0] : promoted;
  if (!(promotedRow as { entry_id?: string } | null)?.entry_id) {
    return { outcome: "no_waitlist_match" };
  }

  const delivery = await notifyWaitlistForSlot({
    salonId: job.salon_id,
    salonName: salonRow?.name ?? "our salon",
    serviceId: row.service_id,
    serviceName: serviceRow?.name ?? "service",
    bookingDateYmd: bookingDate,
  });
  if (!delivery.notified) throw new Error("waitlist_invite_delivery_failed");

  const { error: auditError } = await db.from("ai_actions_log" as never).insert({
    salon_id: job.salon_id,
    agent: "cancellation_radar",
    action_type: "cancellation_autofill_invite",
    target_id: bookingId,
    payload: {
      approval_request_id: job.approval_request_id,
      execution_job_id: job.id,
      waitlist_entry_id: delivery.entryId ?? null,
      booking_date: bookingDate,
      outcome: "invite_sent",
    },
  } as never);
  if (auditError) throw auditError;
  return { outcome: "invite_sent" };
}
