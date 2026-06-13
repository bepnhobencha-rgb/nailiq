import { after } from "next/server";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { parseTimeSlotOnDate } from "@/shared/booking/parseBookingTimeSlot";
import { notifyWaitlistForSlot } from "@/shared/noshow/waitlistAutoFill";
import { serviceBlockMinutes } from "@/shared/booking/bookingBlock";

type RescheduleBody = {
  token: string;
  date: string;    // YYYY-MM-DD
  slotLabel: string; // e.g. "9:00 AM"
};

export async function POST(req: Request) {
  let body: RescheduleBody;
  try {
    body = (await req.json()) as RescheduleBody;
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_body" }, { status: 400 });
  }

  const { token, date, slotLabel } = body;
  if (!token || !date || !slotLabel) {
    return NextResponse.json({ ok: false, code: "missing_params" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  // Resolve booking from token to get service duration + salon + original slot date
  const { data: tokenRow } = await supabase
    .from("booking_reminder_tokens" as never)
    .select("booking_id, used_at, expires_at")
    .eq("id", token)
    .maybeSingle();

  const tr = tokenRow as { booking_id: string; used_at: string | null; expires_at: string } | null;
  if (!tr || tr.used_at !== null || new Date(tr.expires_at) < new Date()) {
    return NextResponse.json({ ok: false, code: "token_invalid" }, { status: 400 });
  }

  const { data: booking } = await supabase
    .from("bookings" as never)
    .select("salon_id, service_id, start_time_utc")
    .eq("id", tr.booking_id)
    .maybeSingle();

  const b = booking as { salon_id: string; service_id: string; start_time_utc: string } | null;
  if (!b) return NextResponse.json({ ok: false, code: "booking_not_found" }, { status: 404 });

  const { data: service } = await supabase
    .from("services" as never)
    .select("duration_minutes, buffer_minutes")
    .eq("id", b.service_id)
    .maybeSingle();

  const svc = service as { duration_minutes: number; buffer_minutes: number | null } | null;
  if (!svc) return NextResponse.json({ ok: false, code: "service_not_found" }, { status: 404 });

  let newStart: Date;
  try {
    newStart = parseTimeSlotOnDate(slotLabel, date);
  } catch {
    return NextResponse.json({ ok: false, code: "invalid_slot" }, { status: 400 });
  }

  const durationMs =
    serviceBlockMinutes(svc.duration_minutes, svc.buffer_minutes) * 60_000;
  const newEnd = new Date(newStart.getTime() + durationMs);

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
  const row = rows[0] as { ok?: boolean; code?: string; service_name?: string; staff_name?: string; new_start_utc?: string } | undefined;

  if (!row?.ok) {
    return NextResponse.json({ ok: false, code: row?.code ?? "unknown" }, { status: 400 });
  }

  // Notify the first waitlist entry for the freed original slot
  const originalDateYmd = b.start_time_utc.split("T")[0];
  const { salon_id, service_id } = b;
  after(async () => {
    const sb = createServiceRoleClient();
    const [{ data: salonData }, { data: svcData }] = await Promise.all([
      sb.from("salons" as never).select("name").eq("id", salon_id).maybeSingle(),
      sb.from("services" as never).select("name").eq("id", service_id).maybeSingle(),
    ]);
    const salonName = (salonData as { name: string } | null)?.name ?? "";
    const serviceName = (svcData as { name: string } | null)?.name ?? "";
    await notifyWaitlistForSlot({ salonId: salon_id, salonName, serviceId: service_id, serviceName, bookingDateYmd: originalDateYmd });
  });

  return NextResponse.json({
    ok: true,
    serviceName: row.service_name,
    staffName: row.staff_name,
    newStartUtc: row.new_start_utc,
  });
}
