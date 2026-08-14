import { after } from "next/server";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { parseTimeSlotToMinutes } from "@/shared/booking/parseBookingTimeSlot";
import { notifyWaitlistForSlot } from "@/shared/noshow/waitlistAutoFill";
import { sendOwnerBookingNotification } from "@/shared/dashboard/sendOwnerBookingNotification";
import {
  salonWallTimeToUtcCandidates,
  salonWallTimeToUtcIso,
  salonYmdOfUtc,
} from "@/shared/lib/salonTime";
import { logBookingEvent } from "@/shared/dashboard/auditLog";

type RescheduleBody = {
  token: string;
  date: string;    // YYYY-MM-DD
  slotLabel: string; // e.g. "9:00 AM"
  /** Exact candidate from the read-only slot API. Required to distinguish the
   * two occurrences of a repeated wall time during a fall-back transition. */
  startUtc?: string;
};

const RESCHEDULE_CONFLICT_CODES = new Set([
  "slot_conflict",
  "resource_conflict",
]);

function rescheduleFailureStatus(code: string) {
  if (RESCHEDULE_CONFLICT_CODES.has(code)) return 409;
  if (code === "booking_not_reschedulable") return 409;
  if (code === "token_invalid") return 410;
  return 400;
}

export async function POST(req: Request) {
  let body: RescheduleBody;
  try {
    body = (await req.json()) as RescheduleBody;
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_body" }, { status: 400 });
  }

  const { token, date, slotLabel, startUtc } = body;
  if (!token || !date || !slotLabel) {
    return NextResponse.json({ ok: false, code: "missing_params" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  // This pre-read is only for converting salon wall time to UTC. The RPC locks
  // the token + booking and returns the authoritative old timestamp/tenant.
  const { data: tokenRow, error: tokenError } = await supabase
    .from("booking_reminder_tokens" as never)
    .select("booking_id, salon_id, used_at, expires_at")
    .eq("id", token)
    .maybeSingle();

  const tr = tokenRow as {
    booking_id: string;
    salon_id: string;
    used_at: string | null;
    expires_at: string;
  } | null;
  if (tokenError || !tr || tr.used_at !== null || new Date(tr.expires_at) < new Date()) {
    return NextResponse.json({ ok: false, code: "token_invalid" }, { status: 410 });
  }

  const { data: booking, error: bookingError } = await supabase
    .from("bookings" as never)
    .select("salon_id")
    .eq("id", tr.booking_id)
    .eq("salon_id", tr.salon_id)
    .maybeSingle();

  const b = booking as { salon_id: string } | null;
  if (bookingError) {
    console.error("[reschedule-action] booking tenant lookup failed", bookingError);
    return NextResponse.json(
      { ok: false, code: "server_error" },
      { status: 500 },
    );
  }
  if (!b) return NextResponse.json({ ok: false, code: "booking_not_found" }, { status: 404 });

  const { data: salonRow, error: salonError } = await supabase
    .from("salons" as never)
    .select("timezone")
    .eq("id", b.salon_id)
    .maybeSingle();
  const salonTimezone = (
    salonRow as { timezone?: string | null } | null
  )?.timezone?.trim();
  if (salonError || !salonTimezone) {
    console.error("[reschedule-action] salon timezone unavailable", salonError);
    return NextResponse.json(
      { ok: false, code: "server_error" },
      { status: 500 },
    );
  }

  let newStart: Date;
  try {
    const startMinutes = parseTimeSlotToMinutes(slotLabel);
    const exactCandidates = salonWallTimeToUtcCandidates(
      date,
      startMinutes,
      salonTimezone,
    );
    if (startUtc) {
      const submittedMs = Date.parse(startUtc);
      if (
        !Number.isFinite(submittedMs) ||
        !exactCandidates.some((candidate) => Date.parse(candidate) === submittedMs)
      ) {
        return NextResponse.json(
          { ok: false, code: "invalid_slot" },
          { status: 400 },
        );
      }
      newStart = new Date(submittedMs);
    } else {
      // Backward compatibility for a client loaded before this release. The
      // legacy deterministic resolver chooses the first occurrence.
      newStart = new Date(
        salonWallTimeToUtcIso(date, startMinutes, salonTimezone),
      );
    }
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_slot" }, { status: 400 });
  }

  // Signature compatibility only. The database ignores this duration and
  // moves the locked original occupied block so add-ons/buffers cannot shrink.
  const newEnd = new Date(newStart.getTime() + 60_000);

  const { data, error } = await supabase.rpc("reschedule_booking_as_customer" as never, {
    p_token_id:      token,
    p_new_start_utc: newStart.toISOString(),
    p_new_end_utc:   newEnd.toISOString(),
  });

  if (error) {
    console.error("[reschedule-action] RPC error", error);
    return NextResponse.json({ ok: false, code: "server_error" }, { status: 500 });
  }

  const rows = Array.isArray(data) ? data : [];
  const row = rows[0] as {
    ok?: boolean;
    code?: string;
    booking_id?: string;
    salon_id?: string;
    service_id?: string;
    service_name?: string;
    staff_name?: string;
    previous_start_utc?: string;
    new_start_utc?: string;
    new_end_utc?: string;
    policy_locked_by_reschedule?: boolean;
  } | undefined;

  if (!row?.ok) {
    const code = row?.code ?? "unknown";
    return NextResponse.json(
      { ok: false, code },
      { status: rescheduleFailureStatus(code) },
    );
  }

  if (
    !row.booking_id ||
    !row.salon_id ||
    !row.service_id ||
    !row.previous_start_utc ||
    !row.new_start_utc
  ) {
    console.error("[reschedule-action] incomplete RPC result", row);
    return NextResponse.json({ ok: false, code: "server_error" }, { status: 500 });
  }
  const policyLockedByReschedule = row.policy_locked_by_reschedule === true;

  void logBookingEvent({
    bookingId: row.booking_id,
    salonId: row.salon_id,
    actorUserId: null,
    actorRole: "public_guest",
    eventType: "booking_rescheduled",
    payload: {
      reason: "customer_email_link",
      previous_start_utc: row.previous_start_utc,
      new_start_utc: row.new_start_utc,
      late_cancel_policy_locked: policyLockedByReschedule,
    },
  });

  // Notify the first waitlist entry for the freed original slot
  const originalStartUtc = row.previous_start_utc;
  const bookingId = row.booking_id;
  const salon_id = row.salon_id;
  const service_id = row.service_id;
  after(async () => {
    // Owner/manager alert — customer self-rescheduled via email link. Booking
    // now holds the NEW start; pass the original as previousStartUtc so the
    // email shows old → new. Best-effort, fire-and-forget.
    await sendOwnerBookingNotification({
      salonId: salon_id,
      bookingId,
      event: "reschedule",
      previousStartUtc: originalStartUtc,
      changedBy: "customer",
      changedFields: ["time"],
    });

    const sb = createServiceRoleClient();
    const [salonRead, serviceRead] = await Promise.all([
      sb.from("salons" as never).select("name, timezone").eq("id", salon_id).maybeSingle(),
      sb.from("services" as never).select("name").eq("id", service_id).eq("salon_id", salon_id).maybeSingle(),
    ]);
    if (salonRead.error || serviceRead.error) {
      console.error("[reschedule-action] waitlist context unavailable", {
        salonError: salonRead.error,
        serviceError: serviceRead.error,
      });
      return;
    }
    const salonData = salonRead.data;
    const svcData = serviceRead.data;
    const salonName = (salonData as { name: string } | null)?.name ?? "";
    const serviceName = (svcData as { name: string } | null)?.name ?? "";
    // Freed slot's date must be the salon-LOCAL day (booking_waitlist_entries
    // stores booking_date in salon-local time). Using the UTC date shifted
    // evening NA bookings one day forward → the picker/SMS targeted the wrong
    // day. Mirror the RPC's salon-tz match.
    const timezone =
      (salonData as { timezone: string | null } | null)?.timezone?.trim() ||
      "America/Los_Angeles";
    const bookingDateYmd = salonYmdOfUtc(originalStartUtc, timezone);
    await notifyWaitlistForSlot({
      salonId: salon_id,
      salonName,
      serviceId: service_id,
      serviceName,
      bookingDateYmd,
      promotionRequestId: token,
    });
  });

  return NextResponse.json({
    ok: true,
    serviceName: row.service_name,
    staffName: row.staff_name,
    newStartUtc: row.new_start_utc,
    timezone: salonTimezone,
    lateCancelPolicyLocked: policyLockedByReschedule,
  });
}
