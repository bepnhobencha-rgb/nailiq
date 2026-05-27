import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { computeTimeSlots } from "@/shared/booking/getAvailableTimeSlots";
import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { salonWallTimeToUtcIso } from "@/shared/lib/salonTime";

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

/**
 * Parse a time-slot label (e.g. "2:00 PM", "9:30 AM") produced by
 * computeTimeSlots / formatSlotLabel and return minutes-from-midnight.
 */
function parseSlotLabelToMinutes(label: string): number | null {
  // Accepts "H:MM AM/PM" or "HH:MM AM/PM" (en-US locale format)
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(label.trim());
  if (!m) return null;
  let h = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  const period = m[3]!.toUpperCase();
  if (period === "PM" && h !== 12) h += 12;
  if (period === "AM" && h === 12) h = 0;
  return h * 60 + min;
}

async function handleConfirmBooking(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
  sessionId: string | null,
) {
  const serviceId     = args.service_id     as string | undefined;
  const date          = args.date           as string | undefined;  // YYYY-MM-DD
  const timeSlot      = args.time_slot      as string | undefined;  // e.g. "2:00 PM"
  const staffId       = args.staff_id       as string | undefined;  // UUID or "any"
  const customerName  = args.customer_name  as string | undefined;
  const customerPhone = args.customer_phone as string | undefined;

  if (!serviceId || !date || !timeSlot || !staffId || !customerName || !customerPhone) {
    return NextResponse.json({ error: "missing_required_booking_fields" }, { status: 400 });
  }

  // ── 1. Load salon by slug → get salon.id and timezone ──────────────────────
  const { data: salon } = await supabase
    .from("salons")
    .select("id, timezone, opening_hours, booking_closed_dates")
    .eq("slug", salonSlug)
    .single();
  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

  // ── 2. Load service → duration for end-time calc ────────────────────────────
  const { data: service } = await supabase
    .from("services")
    .select("id, name, duration_minutes, price_cents")
    .eq("id", serviceId)
    .eq("salon_id", salon.id)
    .single();
  if (!service) return NextResponse.json({ error: "service_not_found" }, { status: 404 });

  // ── 3. Resolve "any" staff → first available active staff member ─────────────
  let resolvedStaffId: string | null = null;
  if (staffId !== "any" && staffId !== BOOKING_ANY_STAFF_ID) {
    resolvedStaffId = staffId;
  } else {
    const { data: firstStaff } = await supabase
      .from("staff")
      .select("id")
      .eq("salon_id", salon.id)
      .eq("status", "active")
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .limit(1)
      .single();
    resolvedStaffId = firstStaff?.id ?? null;
  }
  if (!resolvedStaffId) {
    return NextResponse.json({ error: "no_staff_available" }, { status: 409 });
  }

  // ── 4. Convert date (YYYY-MM-DD) + timeSlot ("2:00 PM") → UTC timestamps ────
  //  Uses salonWallTimeToUtcIso from salonTime.ts (DST-safe Intl binary search)
  const timezone = (salon as { timezone?: string }).timezone ?? "America/Los_Angeles";
  const slotMins = parseSlotLabelToMinutes(timeSlot);
  if (slotMins === null) {
    return NextResponse.json({ error: "invalid_time_slot_format", received: timeSlot }, { status: 400 });
  }
  const endMins = slotMins + (service as { duration_minutes: number }).duration_minutes;

  let startUtcIso: string;
  let endUtcIso: string;
  try {
    startUtcIso = salonWallTimeToUtcIso(date, slotMins, timezone);
    endUtcIso   = salonWallTimeToUtcIso(date, endMins,  timezone);
  } catch (e) {
    return NextResponse.json({ error: "time_conversion_failed", detail: String(e) }, { status: 400 });
  }

  // ── 5. Call create_public_booking RPC with correct parameter names ───────────
  //  The function signature is:
  //    (p_salon_id uuid, p_service_id uuid, p_staff_id uuid, p_client_name text,
  //     p_client_phone text, p_start_time_utc timestamptz, p_end_time_utc timestamptz,
  //     p_status text, p_price_cents int, p_client_notes text, ...)
  const { data: rpcData, error: rpcErr } = await supabase.rpc("create_public_booking", {
    p_salon_id:      salon.id,
    p_service_id:    serviceId,
    p_staff_id:      resolvedStaffId,
    p_client_name:   customerName,
    p_client_phone:  customerPhone,
    p_start_time_utc: startUtcIso,
    p_end_time_utc:   endUtcIso,
    p_status:         "confirmed",
    p_price_cents:    (service as { price_cents: number | null }).price_cents ?? null,
    p_client_notes:   "Voice booking",
  });

  if (rpcErr) {
    console.error("[voice/confirm_booking] RPC error:", rpcErr);
    const errObj = rpcErr as { code?: string; message?: string };
    // P0002 = no_data_found (slot conflict)
    if (errObj.code === "P0002" || errObj.code === "23P01") {
      return NextResponse.json({ error: "slot_conflict", message: "Time slot is no longer available." }, { status: 409 });
    }
    return NextResponse.json({ error: "booking_failed", detail: errObj.message }, { status: 500 });
  }

  // RPC returns jsonb: { success, booking_id, ... } or { success: false, code: ... }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as any;
  if (!result?.success) {
    const code = result?.code ?? "unknown";
    return NextResponse.json({ error: "booking_failed", code }, { status: 409 });
  }

  const bookingId = result.booking_id ?? null;

  // ── 6. Stamp source = 'voice' (RPC doesn't accept this param, defaults to 'appointment') ─
  if (bookingId) {
    try {
      await supabase
        .from("bookings")
        .update({ source: "voice" })
        .eq("id", bookingId);
    } catch { /* best-effort */ }
  }

  // ── 7. Link booking to voice_ai_session ────────────────────────────────────
  if (sessionId && bookingId) {
    try {
      await supabase
        .from("voice_ai_sessions")
        .update({ booking_id: bookingId, status: "completed" })
        .eq("id", sessionId);
    } catch { /* best-effort */ }
  }

  return NextResponse.json({
    success:      true,
    bookingId,
    serviceName:  (service as { name: string }).name,
    date,
    timeSlot,
    customerName,
    customerPhone,
  });
}
