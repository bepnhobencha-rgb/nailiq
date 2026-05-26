import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { computeTimeSlots } from "@/shared/booking/getAvailableTimeSlots";
import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";

export const runtime     = "nodejs";
export const maxDuration = 30;

type ToolCallBody = {
  toolName:    string;
  toolArgs:    Record<string, unknown>;
  sessionId?:  string;
  salonSlug:   string;
};

export async function POST(req: NextRequest) {
  let body: ToolCallBody;
  try {
    body = await req.json() as ToolCallBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { toolName, toolArgs, salonSlug } = body;
  if (!salonSlug) return NextResponse.json({ error: "missing_salon_slug" }, { status: 400 });

  const supabase = createServiceRoleClient();

  if (toolName === "get_available_slots") {
    return handleGetAvailableSlots(supabase, salonSlug, toolArgs);
  }
  if (toolName === "confirm_booking") {
    return handleConfirmBooking(supabase, salonSlug, toolArgs, body.sessionId ?? null);
  }

  return NextResponse.json({ error: "unknown_tool", toolName }, { status: 400 });
}

async function handleGetAvailableSlots(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
) {
  const serviceId = args.service_id as string | undefined;
  const dateYmd   = args.date       as string | undefined;
  const staffId   = (args.staff_id  as string | undefined) ?? BOOKING_ANY_STAFF_ID;

  if (!serviceId || !dateYmd) {
    return NextResponse.json({ error: "missing_required_args: service_id, date" }, { status: 400 });
  }

  // Load salon + service + staff
  const { data: salon } = await supabase
    .from("salons")
    .select("id, opening_hours, booking_closed_dates")
    .eq("slug", salonSlug)
    .single();
  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

  const { data: service } = await supabase
    .from("services")
    .select("duration_minutes")
    .eq("id", serviceId)
    .eq("salon_id", salon.id)
    .single();
  if (!service) return NextResponse.json({ error: "service_not_found" }, { status: 404 });

  const { data: staffRows } = await supabase
    .from("staff")
    .select("id, name, job_role")
    .eq("salon_id", salon.id)
    .eq("status", "active")
    .is("deleted_at", null);

  // Parse the requested date
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateYmd);
  if (!m) return NextResponse.json({ error: "invalid_date_format" }, { status: 400 });
  const selectedDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);

  // Load occupancy for the day
  const dayStart = new Date(selectedDate); dayStart.setHours(0, 0, 0, 0);
  const dayEnd   = new Date(selectedDate); dayEnd.setHours(23, 59, 59, 999);

  const { data: occData } = await supabase.rpc("public_booking_occupancy_for_range", {
    p_salon_id: salon.id,
    p_start:    dayStart.toISOString(),
    p_end:      dayEnd.toISOString(),
  });

  // Check opening hours are parseable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const salonAny = salon as any;
  const week = parseOpeningHours(salonAny.opening_hours);
  if (!week) return NextResponse.json({ slots: [], reason: "invalid_hours_config" });

  const staffList = (staffRows ?? []).map((s) => ({
    id:       s.id,
    name:     s.name,
    job_role: s.job_role,
  }));

  const slots = computeTimeSlots({
    openingHoursRaw:        salonAny.opening_hours,
    selectedDate,
    staffId:                staffId === "any" ? BOOKING_ANY_STAFF_ID : staffId,
    staffList,
    serviceDurationMinutes: service.duration_minutes,
    occupancy:              (occData ?? []) as { staff_id: string; start_time_utc: string; end_time_utc: string }[],
    nowMs:                  Date.now(),
  });

  const available = slots.filter((s) => s.available).map((s) => s.label);
  return NextResponse.json({ slots: available, date: dateYmd, count: available.length });
}

async function handleConfirmBooking(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
  sessionId: string | null,
) {
  const serviceId     = args.service_id     as string | undefined;
  const date          = args.date           as string | undefined;
  const timeSlot      = args.time_slot      as string | undefined;
  const staffId       = args.staff_id       as string | undefined;
  const customerName  = args.customer_name  as string | undefined;
  const customerPhone = args.customer_phone as string | undefined;

  if (!serviceId || !date || !timeSlot || !staffId || !customerName || !customerPhone) {
    return NextResponse.json({ error: "missing_required_booking_fields" }, { status: 400 });
  }

  // Load salon
  const { data: salon } = await supabase
    .from("salons")
    .select("id, timezone, opening_hours, booking_closed_dates")
    .eq("slug", salonSlug)
    .single();
  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

  const { data: service } = await supabase
    .from("services")
    .select("id, name, duration_minutes, price_cents")
    .eq("id", serviceId)
    .eq("salon_id", salon.id)
    .single();
  if (!service) return NextResponse.json({ error: "service_not_found" }, { status: 404 });

  // Call the same create_public_booking RPC
  const { data: rpcData, error: rpcErr } = await supabase.rpc("create_public_booking", {
    p_salon_slug:     salonSlug,
    p_service_id:     serviceId,
    p_date_ymd:       date,
    p_time_slot:      timeSlot,
    p_staff_id:       staffId === "any" ? null : staffId,
    p_client_name:    customerName,
    p_client_phone:   customerPhone,
    p_client_notes:   "Voice booking",
    p_source:         "voice",
  });

  if (rpcErr) {
    const code = (rpcErr as { code?: string }).code;
    if (code === "P0002") {
      return NextResponse.json({ error: "slot_conflict", message: "Time slot is no longer available." }, { status: 409 });
    }
    return NextResponse.json({ error: "booking_failed", detail: rpcErr.message }, { status: 500 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as any;
  const bookingId = result?.booking_id ?? result?.id ?? null;

  // Link booking to voice session (best-effort)
  if (sessionId && bookingId) {
    try {
      await supabase
        .from("voice_ai_sessions")
        .update({ booking_id: bookingId, status: "completed" })
        .eq("id", sessionId);
    } catch { /* ignore */ }
  }

  return NextResponse.json({
    success:      true,
    bookingId,
    serviceName:  service.name,
    date,
    timeSlot,
    customerName,
    customerPhone,
  });
}
