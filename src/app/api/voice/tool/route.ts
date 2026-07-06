import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { sendOwnerBookingNotification } from "@/shared/dashboard/sendOwnerBookingNotification";
import { logBookingEvent } from "@/shared/dashboard/auditLog";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";
import { computeTimeSlots } from "@/shared/booking/getAvailableTimeSlots";
import { parseOpeningHours, type DayKey, type OpeningHoursWeek } from "@/shared/dashboard/openingHoursDefaults";
import { BOOKING_ANY_STAFF_ID } from "@/shared/booking/bookingStaffConstants";
import { serviceBlockMinutes } from "@/shared/booking/bookingBlock";
import { formatInSalonTz, salonDayRangeUtc, salonWallTimeToUtcIso } from "@/shared/lib/salonTime";
import {
  tryAlignedArrangement,
  tryFinishAlignedArrangement,
  buildArrangement,
  findFinishArrangementsInWindow,
  tryWaveArrangement,
  findEarliestWaveArrangement,
  buildWaveArrangement,
  type WaveRawAssignment,
  SLOT_STEP_MIN,
  type GroupArrangement,
  type ResolvedMember,
  type StaffRow,
  type ExistingBooking,
} from "@/shared/booking/groupSchedulerCore";
import {
  buildCapabilityMap,
  type StaffCapabilityMap,
} from "@/shared/booking/staffCapability";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { isValidCustomerName } from "@/shared/lib/nameFormat";
import { createPartyLink } from "@/shared/booking/partyLinkActions";
import type { GroupSyncMode } from "@/shared/booking/loadGroupSmartSchedule";

export const runtime     = "nodejs";
export const maxDuration = 30;

type ToolCallBody = {
  // Primary field names used by the WebRTC client handler.
  toolName?:   string;
  toolArgs?:   Record<string, unknown>;
  salonSlug?:  string;
  sessionId?:  string;
  // Alternate field names accepted from external / direct API callers.
  toolInput?:  Record<string, unknown>;
  salonId?:    string;
};

export async function POST(req: NextRequest) {
  let body: ToolCallBody;
  try {
    body = await req.json() as ToolCallBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Accept both field name conventions so the route is robust to
  // WebRTC client calls (toolArgs / salonSlug) and direct API calls
  // (toolInput / salonId).
  const toolName  = body.toolName;
  const toolArgs  = body.toolArgs ?? body.toolInput ?? {};
  const salonSlug = body.salonSlug ?? body.salonId;
  const sessionId = body.sessionId ?? null;

  if (!toolName)  return NextResponse.json({ error: "missing_tool_name"  }, { status: 400 });
  if (!salonSlug) return NextResponse.json({ error: "missing_salon_slug" }, { status: 400 });

  let supabase: ReturnType<typeof createServiceRoleClient>;
  try {
    supabase = createServiceRoleClient();
  } catch {
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }

  // Gate the whole transactional tool surface on the salon actually having voice
  // AI enabled. The session-mint route already checks this, but this route was
  // directly POST-able with a known slug and no auth — letting a caller
  // create / cancel / reschedule bookings by phone even for salons with voice
  // AI off. Re-check here so the enable flag is enforced at the mutation point.
  {
    const { data: salonRow } = await supabase
      .from("salons")
      .select("voice_ai_enabled")
      .eq("slug", salonSlug)
      .maybeSingle();
    if (!salonRow) {
      return NextResponse.json({ error: "salon_not_found" }, { status: 404 });
    }
    if ((salonRow as { voice_ai_enabled?: boolean | null }).voice_ai_enabled !== true) {
      return NextResponse.json({ error: "voice_not_enabled" }, { status: 403 });
    }
  }

  try {
    if (toolName === "get_available_slots") {
      return handleGetAvailableSlots(supabase, salonSlug, toolArgs);
    }
    if (toolName === "confirm_booking") {
      return handleConfirmBooking(supabase, salonSlug, toolArgs, sessionId);
    }
    if (toolName === "find_booking") {
      return handleFindBooking(supabase, salonSlug, toolArgs);
    }
    if (toolName === "cancel_booking") {
      return handleCancelBooking(supabase, salonSlug, toolArgs, sessionId);
    }
    if (toolName === "reschedule_booking") {
      return handleRescheduleBooking(supabase, salonSlug, toolArgs, sessionId);
    }
    if (toolName === "get_group_available_slots") {
      return handleGetGroupAvailableSlots(supabase, salonSlug, toolArgs);
    }
    if (toolName === "confirm_group_booking") {
      return handleConfirmGroupBooking(supabase, salonSlug, toolArgs, sessionId, req);
    }
    if (toolName === "join_waitlist") {
      return handleJoinWaitlist(supabase, salonSlug, toolArgs);
    }

    return NextResponse.json({ error: "unknown_tool", toolName }, { status: 400 });
  } catch (err) {
    console.error("[voice/tool] unhandled error in", toolName, err);
    return NextResponse.json(
      { error: "internal_error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
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

  // Load salon + service + staff (timezone required for correct slot filtering)
  const { data: salon } = await supabase
    .from("salons")
    .select("id, timezone, opening_hours, booking_closed_dates")
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

  // ── Timezone-aware slot computation ──────────────────────────────────────────
  //
  // Problem: Vercel runs in UTC. computeTimeSlots uses `setHours(0,0,0,0)` which
  // gives UTC midnight as the base. For a Vancouver (UTC-7) salon:
  //   • Server's "10:00 AM" slot = UTC midnight + 600 min = 10:00 UTC
  //   • Actual 10:00 AM PDT                                = 17:00 UTC
  // This causes the past-time filter and conflict check to use the wrong times.
  // Example: at 15:36 PDT (22:36 UTC) all salon slots (10:00–19:00 UTC) look
  // "past" and the AI says "no slots today" even with 4 hours remaining.
  //
  // Fix: compute the offset between salon local midnight and UTC midnight,
  // then shift nowMs and occupancy timestamps by that offset so all comparisons
  // inside computeTimeSlots use a consistent "local fake-UTC" frame.
  //
  // tzOffsetMs  = salonMidnightUtc - utcMidnight
  //   UTC-7:  07:00 UTC - 00:00 UTC = +7h   (25 200 000 ms)
  //   UTC+7:  17:00 UTC of prev day - 00:00 UTC of day = -7h (−25 200 000 ms)
  //
  // adjustedNowMs    = Date.now() − tzOffsetMs
  // adjustedOccupancy = occupancy shifted by −tzOffsetMs
  //
  // In the fake frame, slot "10:00 AM" (10:00 UTC fake) matches a booking at
  // 10:00 AM local (17:00 UTC real) shifted to 10:00 UTC fake. Overlap checks
  // and the past-time guard all produce correct results.
  // ─────────────────────────────────────────────────────────────────────────────
  const timezone = (salon as { timezone?: string }).timezone ?? "America/Los_Angeles";

  // Salon's local midnight expressed in UTC (DST-safe via binary-search Intl)
  const salonMidnightUtcMs = Date.parse(salonWallTimeToUtcIso(dateYmd, 0, timezone));
  // UTC midnight of the same calendar date (what setHours(0,0,0,0) gives on the server)
  const utcMidnightMs = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // How many ms ahead salon midnight is vs UTC midnight (+7h for UTC-7, −7h for UTC+7)
  const tzOffsetMs = salonMidnightUtcMs - utcMidnightMs;

  // Occupancy query: cover the full salon local day (midnight → midnight+24 h)
  // to capture bookings that spill into the next UTC day (e.g. 6 PM PDT = 01:00 UTC+1).
  const dayStart = new Date(salonMidnightUtcMs);
  const dayEnd   = new Date(salonMidnightUtcMs + 24 * 60 * 60 * 1000 - 1);

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

  // Shift occupancy timestamps into fake-UTC frame so conflict detection is correct.
  type OccRow = { staff_id: string; start_time_utc: string; end_time_utc: string };
  const adjustedOccupancy: OccRow[] = (occData ?? []).map((row: OccRow) => ({
    staff_id:       row.staff_id,
    start_time_utc: new Date(Date.parse(row.start_time_utc) - tzOffsetMs).toISOString(),
    end_time_utc:   new Date(Date.parse(row.end_time_utc)   - tzOffsetMs).toISOString(),
  }));

  const slots = computeTimeSlots({
    openingHoursRaw:        salonAny.opening_hours,
    selectedDate,
    staffId:                staffId === "any" ? BOOKING_ANY_STAFF_ID : staffId,
    staffList,
    serviceDurationMinutes: service.duration_minutes,
    occupancy:              adjustedOccupancy,
    // Shift nowMs into the same fake-UTC frame so the past-time filter
    // correctly hides slots that are already past in the salon's local timezone.
    nowMs:                  Date.now() - tzOffsetMs,
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

  // ── 3. Resolve staff ────────────────────────────────────────────────────────
  // "any" → pick the first active staff who has NO conflicting booking at the
  // requested slot. Picking unconditionally by created_at caused slot_conflict
  // when that staff member was already booked, even if others were free.
  let resolvedStaffId: string | null = null;
  let resolvedStaffName: string | null = null;
  if (staffId !== "any" && staffId !== BOOKING_ANY_STAFF_ID) {
    resolvedStaffId = staffId;
    const { data: staffRow } = await supabase
      .from("staff").select("id, name").eq("id", staffId).single();
    resolvedStaffName = staffRow?.name ?? null;
  }
  // "any" resolution deferred to after time conversion so we can check occupancy.

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

  // ── 4b. Resolve "any" staff → first active staff FREE at this specific slot ──
  if (staffId === "any" || staffId === BOOKING_ANY_STAFF_ID) {
    const { data: allStaff } = await supabase
      .from("staff")
      .select("id, name")
      .eq("salon_id", salon.id)
      .eq("status", "active")
      .is("deleted_at", null)
      .order("created_at", { ascending: true });

    // Find first staff who has no overlapping active booking at this time
    for (const s of (allStaff ?? [])) {
      const { data: conflicts } = await supabase
        .from("bookings")
        .select("id")
        .eq("staff_id", s.id)
        .not("status", "in", '("cancelled","waiting")')
        .lt("start_time_utc", endUtcIso)
        .gt("end_time_utc", startUtcIso)
        .limit(1);
      if (!conflicts || conflicts.length === 0) {
        resolvedStaffId   = s.id;
        resolvedStaffName = s.name;
        break;
      }
    }
    if (!resolvedStaffId) {
      return NextResponse.json({ error: "no_staff_available" }, { status: 409 });
    }
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
    p_client_phone:  toCanonicalPhone(customerPhone) ?? customerPhone,
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
        .update({ source: "voice", booking_channel: "voice" } as never)
        .eq("id", bookingId);
    } catch { /* best-effort */ }
    // Owner/admin "new booking" alert (opt-in, fire-and-forget).
    void sendOwnerBookingNotification({
      salonId: String(salon.id),
      bookingId,
      event: "new",
    });
    void logBookingEvent({
      bookingId,
      salonId: String(salon.id),
      actorUserId: null,
      actorRole: "system",
      eventType: "booking_created",
      payload: { source: "voice" },
    });
    // Unified no-show protection gate — runs AI agent when opted-in, falls
    // back to hard rules otherwise.  Voice has no in-session card capture.
    try {
      const { handleBookingProtection } = await import(
        "@/shared/noshow/handleBookingProtection"
      );
      await handleBookingProtection(bookingId, String(salon.id), "voice");
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

  // ── 8. Send SMS confirmation — AWAITED so we can report the real result ──────
  //  Previously fire-and-forget: the UI claimed "SMS sent" even when the send
  //  failed or Twilio wasn't configured. We now await the result and surface an
  //  accurate `smsSent` boolean. SMS failure never fails the booking.
  let smsSent = false;
  if (bookingId) {
    try {
      const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
      const smsRes = await fetch(`${appUrl}/api/booking/sms-confirm`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookingId,
          salonId:      String(salon.id),
          clientPhone:  customerPhone,
          clientName:   customerName,
          serviceName:  (service as { name: string }).name,
          staffName:    resolvedStaffName ?? undefined,
          startTimeUtc: startUtcIso,
        }),
      });
      const smsJson = await smsRes.json().catch(() => ({})) as { ok?: boolean; error?: string };
      smsSent = smsRes.ok && smsJson.ok === true;
      if (!smsSent) {
        // Log the reason (no PII / secrets) so failures are diagnosable.
        console.warn("[voice/confirm_booking] confirmation SMS not sent:", smsJson.error ?? `http_${smsRes.status}`);
      }
    } catch (e: unknown) {
      console.error("[voice/confirm_booking] sms-confirm dispatch failed", e);
      smsSent = false;
    }
  }

  return NextResponse.json({
    success:      true,
    bookingId,
    serviceName:  (service as { name: string }).name,
    date,
    timeSlot,
    customerName,
    customerPhone,
    smsSent,
  });
}

// ─── cancel_booking ──────────────────────────────────────────────────────────
// Cancel an existing booking by setting status = 'cancelled'.
//
// Two input modes:
//   A) booking_id provided  → cancel immediately (trust that AI already confirmed verbally)
//   B) customer_phone only  → phone lookup mode: find upcoming booking(s) and return
//      details WITHOUT cancelling (confirmation_required: true). AI must read back
//      the booking to the customer, get verbal OK, then call again with booking_id.
//
// This eliminates the "AI skips find_booking → passes phone as booking_id" bug.
async function handleCancelBooking(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
  sessionId: string | null,
) {
  const bookingId     = args.booking_id     as string | undefined;
  const customerPhone = args.customer_phone as string | undefined;
  const reason        = (args.reason as string | undefined) ?? "customer_request";

  // At least one of booking_id or customer_phone is required.
  if (!bookingId && !customerPhone) {
    return NextResponse.json(
      { error: "missing_booking_id_or_phone",
        hint: "Provide booking_id (if known) or customer_phone to look up the booking." },
      { status: 400 },
    );
  }

  // Load salon → needed for both paths
  const { data: salon } = await supabase
    .from("salons")
    .select("id, timezone")
    .eq("slug", salonSlug)
    .single();
  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

  const tz = (salon as { timezone?: string }).timezone ?? "America/Los_Angeles";

  // ── Path B: phone lookup (no booking_id yet) ────────────────────────────────
  if (!bookingId && customerPhone) {
    const digits = customerPhone.replace(/\D/g, "");
    const last9  = digits.slice(-9);
    const now    = new Date().toISOString();

    // Limit 20 — group bookings create one row per member (8-person group = 8 rows).
    // Old limit of 3 caused "only 3 cancelled out of 8" for group bookings.
    // Include staff join so AI can read individual member slots for partial cancellation.
    const { data: phoneRows } = await supabase
      .from("bookings")
      .select("id, group_id, client_name, start_time_utc, status, services!bookings_service_id_fkey(name), staff!bookings_staff_id_fkey(name)")
      .eq("salon_id", salon.id)
      .ilike("client_phone", `%${last9}`)
      .gte("start_time_utc", now)
      .neq("status", "cancelled")
      .order("start_time_utc", { ascending: true })
      .limit(20);

    if (!phoneRows || phoneRows.length === 0) {
      return NextResponse.json({
        error:   "booking_not_found",
        message: "Không tìm thấy lịch hẹn nào sắp tới cho số điện thoại này.",
      }, { status: 404 });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const formatRow = (r: Record<string, any>) => {
      const svcRaw  = r.services as { name?: string } | { name?: string }[] | null;
      const svcName = (Array.isArray(svcRaw) ? svcRaw[0]?.name : svcRaw?.name) ?? "Unknown";
      // Staff join returns a single object (many-to-one FK)
      const staffRaw  = r.staff as { name?: string } | null;
      const staffName = staffRaw?.name ?? null;
      const localTime = new Date(r.start_time_utc as string).toLocaleString("en-US", {
        timeZone: tz, weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true,
      });
      return {
        booking_id:   r.id as string,
        group_id:     (r.group_id as string | null) ?? null,
        service_name: svcName,
        staff_name:   staffName,
        date_time:    localTime,
        status:       r.status as string,
        client_name:  r.client_name as string,
      };
    };

    const rows = phoneRows.map(formatRow);

    // Detect group bookings: all rows sharing the same non-null group_id
    const firstGroupId = rows[0]?.group_id ?? null;
    const allSameGroup = firstGroupId !== null && rows.every((r) => r.group_id === firstGroupId);

    if (allSameGroup) {
      // Group booking — let the customer choose full or partial cancellation.
      // Each row in `bookings` includes service_name, staff_name, date_time so the
      // AI can read individual member slots for partial cancellation.
      return NextResponse.json({
        confirmation_required: true,
        is_group_booking:      true,
        group_id:              firstGroupId,
        group_size:            rows.length,
        bookings:              rows,
        hint:
          `GROUP BOOKING of ${rows.length} people. ` +
          `STEP 1 — Ask: "Bạn muốn huỷ cả nhóm ${rows.length} người, hay chỉ một số người?" ` +
          `FULL CANCEL: call cancel_booking with group_id="${firstGroupId}" — cancels all ${rows.length} at once. ` +
          `PARTIAL CANCEL: read each member's slot (e.g. "Guest 1: Pedicure lúc 12:00 với Jenny"), ` +
          `ask which ones to cancel, then call cancel_booking(booking_id) for each confirmed cancellation individually. ` +
          `After partial cancel: confirm total cancelled (e.g. "Đã huỷ 2 người. ${rows.length - 2} người còn lại giữ nguyên lịch.").`,
      });
    }

    if (rows.length > 1) {
      // Multiple independent bookings — AI must ask which to cancel
      return NextResponse.json({
        confirmation_required: true,
        multiple_bookings:     true,
        bookings:              rows,
        hint: "Multiple upcoming bookings found. Read them back to the customer, ask which one to cancel, then call cancel_booking(booking_id) with their choice.",
      });
    }

    // Exactly one individual booking — return for verbal confirmation before cancelling
    return NextResponse.json({
      confirmation_required: true,
      booking:               rows[0]!,
      hint: "Read this booking back to the customer and ask them to confirm cancellation. Then call cancel_booking(booking_id) with the booking_id above to execute.",
    });
  }

  // ── Path A: group_id provided → cancel ALL bookings in the group ────────────
  const groupIdArg = args.group_id as string | undefined;
  if (!bookingId && groupIdArg) {
    const { data: groupRows, error: grpErr } = await supabase
      .from("bookings")
      .select("id, status")
      .eq("salon_id", salon.id)
      .eq("group_id", groupIdArg)
      .neq("status", "cancelled");

    if (grpErr || !groupRows || groupRows.length === 0) {
      return NextResponse.json({ error: "group_not_found_or_already_cancelled" }, { status: 404 });
    }

    const ids = groupRows.map((r) => r.id as string);
    const { error: cancelErr } = await supabase
      .from("bookings")
      .update({ status: "cancelled" })
      .in("id", ids);

    if (cancelErr) {
      return NextResponse.json({ error: "cancel_failed", detail: cancelErr.message }, { status: 500 });
    }

    // Audit log — one entry per booking in the group
    ids.forEach((id) =>
      void logBookingEvent({
        bookingId: id,
        salonId: String(salon.id),
        actorUserId: null,
        actorRole: "system",
        eventType: "booking_cancelled",
        payload: { reason: "voice_ai_group_cancel", group_id: groupIdArg },
      }),
    );

    // Owner/admin "cancelled" alert — one email for the group (first booking).
    if (ids[0]) {
      void sendOwnerBookingNotification({
        salonId: String(salon.id),
        bookingId: ids[0],
        event: "cancel",
      });
    }

    return NextResponse.json({
      success:        true,
      cancelled_count: ids.length,
      group_id:        groupIdArg,
      message: `Đã huỷ thành công ${ids.length} lịch trong nhóm.`,
    });
  }

  // ── Path A: booking_id provided → cancel immediately ────────────────────────
  const { data: booking } = await supabase
    .from("bookings")
    .select("id, salon_id, status, client_name, group_id, start_time_utc, services!bookings_service_id_fkey(name)")
    .eq("id", bookingId!)
    .eq("salon_id", salon.id)
    .single();

  if (!booking) return NextResponse.json({ error: "booking_not_found" }, { status: 404 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bk = booking as any as {
    id: string; status: string; client_name: string;
    start_time_utc: string;
    services: { name: string } | { name: string }[] | null;
  };
  const serviceName = Array.isArray(bk.services)
    ? (bk.services[0]?.name ?? "Unknown")
    : (bk.services?.name ?? "Unknown");

  if (bk.status === "cancelled") {
    return NextResponse.json({ error: "already_cancelled" }, { status: 409 });
  }

  const localTime = new Date(bk.start_time_utc).toLocaleString("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });

  // UPDATE status → cancelled
  const { error: updateErr } = await supabase
    .from("bookings")
    .update({ status: "cancelled" })
    .eq("id", bookingId!);

  if (updateErr) {
    console.error("[voice/cancel_booking] update error:", updateErr);
    return NextResponse.json({ error: "cancel_failed", detail: updateErr.message }, { status: 500 });
  }

  void logBookingEvent({
    bookingId: bookingId!,
    salonId: String(salon.id),
    actorUserId: null,
    actorRole: "system",
    eventType: "booking_cancelled",
    payload: { reason: "voice_ai_cancel" },
  });

  // Owner/admin "cancelled" alert (opt-in, fire-and-forget).
  void sendOwnerBookingNotification({
    salonId: String(salon.id),
    bookingId: bookingId!,
    event: "cancel",
  });

  // Update voice session (best-effort)
  if (sessionId) {
    try {
      await supabase
        .from("voice_ai_sessions")
        .update({ status: "completed" })
        .eq("id", sessionId);
    } catch { /* best-effort */ }
  }

  return NextResponse.json({
    success:     true,
    bookingId,
    serviceName,
    dateTime:    localTime,
    clientName:  bk.client_name,
    reason,
    message:     "Lịch hẹn đã được hủy thành công.",
  });
}

// ─── find_booking ────────────────────────────────────────────────────────────
// Look up upcoming bookings for a customer by phone number.
// Used when the customer wants to reschedule in a new session.
async function handleFindBooking(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
) {
  const customerPhone = args.customer_phone as string | undefined;
  if (!customerPhone) {
    return NextResponse.json({ error: "missing_customer_phone" }, { status: 400 });
  }

  const { data: salon } = await supabase
    .from("salons")
    .select("id, timezone")
    .eq("slug", salonSlug)
    .single();
  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

  // Match on last 9 digits — handles +84, +1, spaces, dashes, etc.
  const digits = customerPhone.replace(/\D/g, "");
  const last9  = digits.slice(-9);

  const now = new Date().toISOString();

  // Single query: phone suffix match on upcoming non-cancelled bookings
  const { data: phoneRows } = await supabase
    .from("bookings")
    .select("id, start_time_utc, end_time_utc, status, client_name, services!bookings_service_id_fkey(name)")
    .eq("salon_id", salon.id)
    .ilike("client_phone", `%${last9}`)
    .gte("start_time_utc", now)
    .neq("status", "cancelled")
    .order("start_time_utc", { ascending: true })
    .limit(3);

  if (!phoneRows || phoneRows.length === 0) {
    return NextResponse.json({
      bookings: [],
      message:  "Không tìm thấy lịch hẹn nào sắp tới cho số điện thoại này.",
    });
  }

  const tz = (salon as { timezone?: string }).timezone ?? "America/Los_Angeles";
  const formatted = phoneRows.map((b) => {
    const start = new Date(b.start_time_utc as string);
    const localStr = start.toLocaleString("en-US", {
      timeZone: tz, weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svcRaw = (b as any).services as { name?: string } | { name?: string }[] | null;
    const svcName = (Array.isArray(svcRaw) ? svcRaw[0]?.name : svcRaw?.name) ?? "Unknown service";
    return {
      booking_id:   b.id,
      service_name: svcName,
      date_time:    localStr,
      status:       b.status,
      client_name:  b.client_name,
    };
  });

  return NextResponse.json({ bookings: formatted });
}

// ─── reschedule_booking ──────────────────────────────────────────────────────
// UPDATE an existing booking to a new date/time.
// Preserves booking_id, history, and deposits.
async function handleRescheduleBooking(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
  sessionId: string | null,
) {
  const bookingId  = args.booking_id    as string | undefined;
  const newDate    = args.new_date      as string | undefined;  // YYYY-MM-DD
  const newSlot    = args.new_time_slot as string | undefined;  // "3:00 PM"
  const staffArg   = args.staff_id      as string | undefined;

  if (!bookingId || !newDate || !newSlot || !staffArg) {
    return NextResponse.json({ error: "missing_required_fields" }, { status: 400 });
  }

  // Load salon
  const { data: salon } = await supabase
    .from("salons")
    .select("id, timezone")
    .eq("slug", salonSlug)
    .single();
  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

  // Load existing booking — verify it belongs to this salon
  const { data: booking } = await supabase
    .from("bookings")
    .select("id, salon_id, service_id, staff_id, start_time_utc, end_time_utc, status, client_name, client_phone")
    .eq("id", bookingId)
    .eq("salon_id", salon.id)
    .single();

  if (!booking) return NextResponse.json({ error: "booking_not_found" }, { status: 404 });
  if ((booking as { status: string }).status === "cancelled") {
    return NextResponse.json({ error: "booking_already_cancelled" }, { status: 409 });
  }

  // Load service for duration
  const { data: service } = await supabase
    .from("services")
    .select("id, name, duration_minutes")
    .eq("id", (booking as { service_id: string }).service_id)
    .single();
  if (!service) return NextResponse.json({ error: "service_not_found" }, { status: 404 });

  // Resolve staff: keep same if "any" or "same", else use provided ID
  const currentStaffId = (booking as { staff_id: string | null }).staff_id;
  let resolvedStaffId = currentStaffId;
  if (staffArg !== "any" && staffArg !== "same" && staffArg !== BOOKING_ANY_STAFF_ID) {
    resolvedStaffId = staffArg;
  }

  // Convert new date + time slot → UTC (DST-safe)
  const timezone = (salon as { timezone?: string }).timezone ?? "America/Los_Angeles";
  const slotMins = parseSlotLabelToMinutes(newSlot);
  if (slotMins === null) {
    return NextResponse.json({ error: "invalid_time_slot_format", received: newSlot }, { status: 400 });
  }
  const svc = service as { duration_minutes: number; name: string };
  const endMins = slotMins + svc.duration_minutes;

  let newStartUtc: string;
  let newEndUtc: string;
  try {
    newStartUtc = salonWallTimeToUtcIso(newDate, slotMins, timezone);
    newEndUtc   = salonWallTimeToUtcIso(newDate, endMins,  timezone);
  } catch (e) {
    return NextResponse.json({ error: "time_conversion_failed", detail: String(e) }, { status: 400 });
  }

  // Conflict check — exclude THIS booking from the check
  // (its current slot will be freed when we move it)
  const { data: conflicts } = await supabase
    .from("bookings")
    .select("id")
    .eq("salon_id", salon.id)
    .eq("staff_id", resolvedStaffId ?? "")
    .neq("id", bookingId)
    .not("status", "in", `("cancelled","waiting")`)
    .lt("start_time_utc", newEndUtc)
    .gt("end_time_utc", newStartUtc)
    .limit(1);

  if (conflicts && conflicts.length > 0) {
    return NextResponse.json({
      error:   "slot_conflict",
      message: "Khung giờ mới không còn trống. Vui lòng chọn giờ khác.",
    }, { status: 409 });
  }

  // UPDATE booking — preserve ID, history, deposits
  const oldStart = (booking as { start_time_utc: string }).start_time_utc;
  const { error: updateErr } = await supabase
    .from("bookings")
    .update({
      start_time_utc:            newStartUtc,
      end_time_utc:              newEndUtc,
      ...(resolvedStaffId ? { staff_id: resolvedStaffId } : {}),
      rescheduled_from_time_utc: oldStart,
      rescheduled_at:            new Date().toISOString(),
      rescheduled_by:            "voice",
    })
    .eq("id", bookingId);

  if (updateErr) {
    console.error("[voice/reschedule_booking] update error:", updateErr);
    return NextResponse.json({ error: "reschedule_failed", detail: updateErr.message }, { status: 500 });
  }

  // Owner/admin "rescheduled" alert (opt-in, fire-and-forget).
  void sendOwnerBookingNotification({
    salonId: String(salon.id),
    bookingId,
    event: "reschedule",
    previousStartUtc: oldStart,
  });

  // Update voice session if we have one
  if (sessionId) {
    try {
      await supabase
        .from("voice_ai_sessions")
        .update({ booking_id: bookingId })
        .eq("id", sessionId);
    } catch { /* best-effort */ }
  }

  return NextResponse.json({
    success:     true,
    bookingId,
    serviceName: svc.name,
    newDate,
    newTimeSlot: newSlot,
    clientName:  (booking as { client_name: string }).client_name,
    message:     "Lịch hẹn đã được dời thành công. Booking ID giữ nguyên.",
  });
}

// ─── join_waitlist ───────────────────────────────────────────────────────────
// Add a customer to the booking waitlist for a service on a given date when no
// slot is available. Mirrors the online waitlist path (submitPublicWaitlistEntry)
// but runs server-side with the service-role client. Writes via the same
// create_public_waitlist_entry RPC, so voice entries land in the Receptionist
// Center waitlist panel and the auto-fill/notify pipeline exactly like online
// ones. Records interest only — never creates a booking.
async function handleJoinWaitlist(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
) {
  const serviceId     = args.service_id     as string | undefined;
  const date          = args.date           as string | undefined; // YYYY-MM-DD
  const customerName  = args.customer_name  as string | undefined;
  const customerPhone = args.customer_phone as string | undefined;
  const staffId       = (args.staff_id      as string | undefined) ?? BOOKING_ANY_STAFF_ID;
  const preferredTime = (args.preferred_time as string | undefined) ?? "";

  if (!serviceId || !date || !customerName || !customerPhone) {
    return NextResponse.json(
      { error: "missing_required_args: service_id, date, customer_name, customer_phone" },
      { status: 400 },
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "invalid_date: expected YYYY-MM-DD" }, { status: 400 });
  }

  const phoneOk = validateGuestPhone(customerPhone);
  if (!phoneOk.ok) {
    return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
  }
  const nameTrimmed = customerName.trim();
  if (!isValidCustomerName(nameTrimmed)) {
    return NextResponse.json({ error: "invalid_name" }, { status: 400 });
  }

  // Load salon → id; also fetch service for a friendly read-back + ownership check.
  const { data: salon } = await supabase
    .from("salons")
    .select("id")
    .eq("slug", salonSlug)
    .single();
  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

  const { data: service } = await supabase
    .from("services")
    .select("name")
    .eq("id", serviceId)
    .eq("salon_id", salon.id)
    .single();
  if (!service) return NextResponse.json({ error: "service_not_found" }, { status: 404 });

  const staffUuid =
    staffId === BOOKING_ANY_STAFF_ID || staffId === "any" || !staffId.trim()
      ? null
      : staffId;

  const { data: rpcRows, error: rpcErr } = await supabase.rpc(
    "create_public_waitlist_entry",
    {
      p_salon_id:             salon.id,
      p_service_id:           serviceId,
      p_staff_id:             staffUuid,
      p_booking_date:         date,
      p_preferred_slot_label: preferredTime,
      p_client_name:          nameTrimmed,
      p_client_phone:         phoneOk.digits,
      // Same semantic reason the online flow uses when the wanted slot is full,
      // so the waitlist loader/UI treats voice entries identically.
      p_source:               "slot_unavailable",
      p_client_email:         null,
    },
  );

  if (rpcErr) {
    console.error("[voice/join_waitlist] RPC error:", rpcErr);
    return NextResponse.json({ error: "waitlist_failed", detail: rpcErr.message }, { status: 500 });
  }

  const row = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  const waitlistId =
    row && typeof row === "object" && "id" in row && row.id != null
      ? String((row as { id: unknown }).id)
      : "";
  if (!waitlistId) {
    return NextResponse.json({ error: "waitlist_empty" }, { status: 500 });
  }

  return NextResponse.json({
    success:     true,
    waitlistId,
    serviceName: (service as { name: string }).name,
    date,
    preferredTime: preferredTime || null,
    message:
      "Added to the waitlist. The customer will get an SMS if a matching slot opens up. " +
      "This is NOT a confirmed booking — tell them you'll notify them if something frees up.",
  });
}

// ═══════════════════════════════════════════════════════════════════
// GROUP BOOKING TOOLS
// ═══════════════════════════════════════════════════════════════════

// ─── Shared helpers ──────────────────────────────────────────────

/** Parse "HH:MM" (24-hour) → minutes from midnight.  Returns null if malformed. */
function parseHm24(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const h = parseInt(m[1]!, 10);
  const min = parseInt(m[2]!, 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** UTC ms → salon-local "HH:MM" (24h) string. */
function utcMsToSalonHm24(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour:     "2-digit",
    minute:   "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const hh = parts.find((p) => p.type === "hour")?.value   ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hh}:${mm}`;
}

/** Return the weekday key ("mon"…"sun") for a YYYY-MM-DD date. */
const DAY_KEYS_BY_IDX: readonly DayKey[] = ["sun","mon","tue","wed","thu","fri","sat"];
function dayKeyForYmd(ymd: string): DayKey | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const idx = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)).getUTCDay();
  return DAY_KEYS_BY_IDX[idx] ?? null;
}

// ─── Shared context loader ───────────────────────────────────────

type ServiceInfo = {
  id:        string;
  name:      string;
  totalMin:  number;   // duration + buffer
  bufferMin: number;   // per-service buffer ("Chuẩn bị") — drives inter-wave gap
  priceCents: number | null;
};

type GroupCtx = {
  salonId:         string;
  timezone:        string;
  openingWeek:     OpeningHoursWeek;
  dayHours:        { open: string; close: string; closed: boolean };
  resolvedMembers: ResolvedMember[];
  staffList:       StaffRow[];
  staffById:       Map<string, StaffRow>;
  capability:      StaffCapabilityMap;
  existing:        ExistingBooking[];
  serviceById:     Map<string, ServiceInfo>;
};

/**
 * Loads and validates everything a group scheduler call needs:
 * salon, services, staff, capability map, and existing occupancy for `dateYmd`.
 * Returns a structured error string if anything is missing/invalid.
 */
async function loadGroupCtx(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  serviceAssignments: { service_id: string; count: number }[],
  dateYmd: string,
): Promise<GroupCtx | { error: string; status: number }> {
  // 1. Salon
  const { data: salonRaw } = await supabase
    .from("salons")
    .select("id, timezone, opening_hours")
    .eq("slug", salonSlug)
    .single();
  if (!salonRaw) return { error: "salon_not_found", status: 404 };
  const salon = salonRaw as unknown as { id: string; timezone?: string; opening_hours?: unknown };
  const timezone = (typeof salon.timezone === "string" && salon.timezone.trim())
    ? salon.timezone.trim()
    : "America/Vancouver";

  // 2. Opening hours
  const openingWeek = parseOpeningHours(salon.opening_hours);
  if (!openingWeek) return { error: "invalid_opening_hours", status: 400 };
  const dayKey = dayKeyForYmd(dateYmd);
  const dayHours = dayKey ? openingWeek[dayKey] : null;
  if (!dayHours || dayHours.closed) return { error: "salon_closed_on_this_day", status: 409 };

  // 3. Expand service_assignments → flat service-id list (validates counts)
  const expandedServiceIds: string[] = [];
  for (const { service_id, count } of serviceAssignments) {
    if (!service_id || typeof count !== "number" || count < 1 || !Number.isInteger(count)) {
      return { error: "invalid_service_assignment: service_id required and count must be integer ≥ 1", status: 400 };
    }
    for (let i = 0; i < count; i++) expandedServiceIds.push(service_id);
  }
  const totalMembers = expandedServiceIds.length;
  if (totalMembers < 2 || totalMembers > 20) {
    return { error: "group_size_must_be_2_to_20", status: 400 };
  }

  // 4. Load services
  const uniqueIds = [...new Set(expandedServiceIds)];
  const { data: svcRows } = await supabase
    .from("services")
    .select("id, name, duration_minutes, buffer_minutes, price_cents")
    .in("id", uniqueIds)
    .eq("salon_id", salon.id)
    .is("deleted_at", null);

  const serviceById = new Map<string, ServiceInfo>();
  for (const r of svcRows ?? []) {
    serviceById.set(String(r.id), {
      id:         String(r.id),
      name:       String(r.name ?? ""),
      totalMin:   serviceBlockMinutes(r.duration_minutes, r.buffer_minutes),
      bufferMin:  Number(r.buffer_minutes) || 0,
      priceCents: r.price_cents != null ? Number(r.price_cents) : null,
    });
  }
  for (const id of uniqueIds) {
    if (!serviceById.has(id)) return { error: `service_not_found: ${id}`, status: 404 };
  }

  // 5. Build resolvedMembers (no preferred staff in voice group flow)
  const resolvedMembers: ResolvedMember[] = expandedServiceIds.map((svcId, i) => {
    const svc = serviceById.get(svcId)!;
    return {
      index:           i,
      name:            `Guest ${i + 1}`,
      serviceId:       svcId,
      serviceName:     svc.name,
      totalMinutes:    svc.totalMin,
      bufferMinutes:   svc.bufferMin,
      priceCents:      svc.priceCents,
      preferredStaffId: null,
    };
  });

  // 6. Staff
  const { data: staffRows } = await supabase
    .from("staff")
    .select("id, name")
    .eq("salon_id", salon.id)
    .eq("status", "active")
    .is("deleted_at", null);
  const staffList: StaffRow[] = (staffRows ?? []).map((s) => ({
    id:   String(s.id),
    name: String(s.name ?? ""),
  }));
  // Phase 6: a group LARGER than the staff count is no longer rejected here —
  // the wave scheduler serves it across multiple time waves. Only reject when the
  // salon has no active staff at all (nothing can be scheduled).
  if (staffList.length === 0) {
    return { error: "no_active_staff", status: 409 };
  }
  const staffById = new Map<string, StaffRow>();
  for (const s of staffList) staffById.set(s.id, s);

  // 7. Staff capability
  const { data: capRows } = await supabase
    .from("staff_services")
    .select("staff_id, service_id")
    .in("staff_id", staffList.map((s) => s.id));
  const capability: StaffCapabilityMap =
    capRows && capRows.length > 0
      ? buildCapabilityMap(capRows.map((r) => ({ staff_id: String(r.staff_id), service_id: String(r.service_id) })))
      : null; // null = all staff can do all services (backward-compat)

  // 8. Existing bookings for the day
  const { startUtc, endUtc } = salonDayRangeUtc(dateYmd, timezone);
  const { data: occRows } = await supabase.rpc("public_booking_occupancy_for_range", {
    p_salon_id: salon.id,
    p_start:    startUtc,
    p_end:      endUtc,
  });
  const existing: ExistingBooking[] = ((occRows ?? []) as Array<{
    staff_id: string;
    start_time_utc: string;
    end_time_utc: string;
  }>).flatMap((row) => {
    if (!row.staff_id) return [];
    const startMs = Date.parse(row.start_time_utc);
    const endMs   = Date.parse(row.end_time_utc);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
    return [{ staffId: String(row.staff_id), startMs, endMs }];
  });

  return {
    salonId:         String(salon.id),
    timezone,
    openingWeek,
    dayHours,
    resolvedMembers,
    staffList,
    staffById,
    capability,
    existing,
    serviceById,
  };
}

// ─── get_group_available_slots ───────────────────────────────────

/**
 * Return up to 3 voice-friendly group arrangements around `target_time`.
 * For sync_start: scans ±90 min around target, returns start-aligned options.
 * For sync_finish: delegates to findFinishArrangementsInWindow.
 */
async function handleGetGroupAvailableSlots(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
) {
  // 1. Parse args
  const serviceAssignments = args.service_assignments as { service_id: string; count: number }[] | undefined;
  const dateYmd   = args.date        as string | undefined;
  const mode      = ((args.mode as string | undefined) ?? "sync_start") as GroupSyncMode;
  const targetRaw = args.target_time as string | undefined;

  if (!Array.isArray(serviceAssignments) || serviceAssignments.length === 0) {
    return NextResponse.json({ error: "missing_service_assignments" }, { status: 400 });
  }
  if (!dateYmd || !/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
    return NextResponse.json({ error: "invalid_date: expected YYYY-MM-DD" }, { status: 400 });
  }
  if (!targetRaw) {
    return NextResponse.json({ error: "missing_target_time: expected HH:MM (24h)" }, { status: 400 });
  }
  const targetMin = parseHm24(targetRaw);
  if (targetMin === null) {
    return NextResponse.json({ error: "invalid_target_time: expected HH:MM format like 14:00" }, { status: 400 });
  }

  // 2. Load scheduling context
  const ctxOrErr = await loadGroupCtx(supabase, salonSlug, serviceAssignments, dateYmd);
  if ("error" in ctxOrErr) {
    return NextResponse.json({ error: ctxOrErr.error }, { status: ctxOrErr.status });
  }
  const ctx = ctxOrErr;

  const openMin  = parseHm24(ctx.dayHours.open)  ?? 0;
  const closeMin = parseHm24(ctx.dayHours.close) ?? 0;

  // 3. Find arrangements
  let arrangements: GroupArrangement[] = [];

  if (mode === "sync_finish") {
    // Use the finish-aligned search from core
    const finishMs  = Date.parse(salonWallTimeToUtcIso(dateYmd, targetMin, ctx.timezone));
    const dayOpenMs = Date.parse(salonWallTimeToUtcIso(dateYmd, openMin,   ctx.timezone));
    const dayCloseMs = Date.parse(salonWallTimeToUtcIso(dateYmd, closeMin, ctx.timezone));
    arrangements = findFinishArrangementsInWindow({
      targetFinishMs:  finishMs,
      dayOpenMs,
      dayCloseMs,
      date:            dateYmd,
      timezone:        ctx.timezone,
      resolvedMembers: ctx.resolvedMembers,
      staffList:       ctx.staffList,
      staffById:       ctx.staffById,
      capability:      ctx.capability,
      existing:        ctx.existing,
    });
  } else {
    // sync_start: scan ±90 min around target_time, collect up to 3 distinct arrangements
    const SEARCH_RADIUS_MIN = 90;
    const winStart = Math.max(openMin, targetMin - SEARCH_RADIUS_MIN);
    const winEnd   = Math.min(closeMin, targetMin + SEARCH_RADIUS_MIN);
    const maxMemberMin = ctx.resolvedMembers.reduce((acc, m) => Math.max(acc, m.totalMinutes), 0);

    for (let mm = winStart; mm <= winEnd && arrangements.length < 3; mm += SLOT_STEP_MIN) {
      const anchorMs  = Date.parse(salonWallTimeToUtcIso(dateYmd, mm, ctx.timezone));
      const dayCloseMs = Date.parse(salonWallTimeToUtcIso(dateYmd, closeMin, ctx.timezone));
      // Skip anchors where the longest service would go past closing
      if (Number.isFinite(dayCloseMs) && anchorMs + maxMemberMin * 60_000 > dayCloseMs) continue;
      const result = tryAlignedArrangement(
        anchorMs,
        ctx.resolvedMembers,
        ctx.staffList,
        ctx.staffById,
        ctx.capability,
        ctx.existing,
        false, // voice doesn't enforce preferred staff
      );
      if (!result) continue;
      const arr = buildArrangement("best", result, ctx.resolvedMembers, ctx.staffById, ctx.timezone);
      // Deduplicate by group start time
      if (!arrangements.some((a) => a.groupStartMs === arr.groupStartMs)) {
        arrangements.push(arr);
      }
    }
  }

  // ── Wave fallback (Phase 6, sync_start only) ──────────────────────────────
  // No simultaneous arrangement exists in the ±90 window — the party is larger
  // than the salon can serve at once. Offer a multi-wave split starting at the
  // requested time instead of returning "no availability".
  if (arrangements.length === 0 && mode === "sync_start") {
    const anchorMs   = Date.parse(salonWallTimeToUtcIso(dateYmd, targetMin, ctx.timezone));
    const dayCloseMs = Date.parse(salonWallTimeToUtcIso(dateYmd, closeMin,  ctx.timezone));
    // Discovery path: forward-scan from the requested time so a group whose
    // requested slot is full is still offered the earliest later wave window
    // today, instead of "no availability" while the afternoon sits open.
    const waveRaw = findEarliestWaveArrangement(
      anchorMs, ctx.resolvedMembers, ctx.staffList, ctx.staffById,
      ctx.capability, ctx.existing, dayCloseMs,
    );
    if (waveRaw && waveRaw.assignments.length === ctx.resolvedMembers.length) {
      const waveArr = buildWaveArrangement(waveRaw, ctx.resolvedMembers, ctx.staffById, ctx.timezone);
      if (waveArr.isWaveBooking) {
        return NextResponse.json({
          arrangements: [{
            index:        0,
            isWaveBooking: true,
            waveCount:    waveArr.waveCount,
            startDisplay: waveArr.groupStartDisplay,
            endDisplay:   waveArr.groupEndDisplay,
            startTime:    utcMsToSalonHm24(waveArr.groupStartMs, ctx.timezone), // pass back as `time`
            waves:        waveArr.waves.map((w) => ({
              waveNumber:   w.waveNumber,
              startTime:    utcMsToSalonHm24(w.startMs, ctx.timezone),
              startDisplay: w.startDisplay,
              endDisplay:   w.endDisplay,
              memberCount:  w.memberCount,
            })),
            summary:      waveArr.summary,
          }],
          count:        1,
          date:         dateYmd,
          mode,
          totalMembers: ctx.resolvedMembers.length,
          isWaveOption: true,
          hint:
            "WAVE option for a large group (more guests than available staff). Explain simply: " +
            "the party is too big to all start together, so it's split into waves. Say the wave " +
            "start times and counts (from `waves`). Do NOT read individual staff assignments. If the " +
            "customer agrees, call confirm_group_booking with the SAME date and time (the wave-1 start).",
        });
      }
    }
  }

  // ── sync_finish large group: waves not supported this phase ────────────────
  if (arrangements.length === 0 && mode === "sync_finish") {
    return NextResponse.json({
      slots:        [],
      count:        0,
      date:         dateYmd,
      mode,
      totalMembers: ctx.resolvedMembers.length,
      message:
        "Finish together is not available for this large group. Try arrive together or a different time.",
    });
  }

  if (arrangements.length === 0) {
    return NextResponse.json({
      slots:        [],
      count:        0,
      date:         dateYmd,
      mode,
      totalMembers: ctx.resolvedMembers.length,
      message:      "No group slots available at the requested time. Please try a different time or date.",
    });
  }

  // 4. Format for voice — never read individual assignments aloud
  const totalMembers = ctx.resolvedMembers.length;
  const voiceArrangements = arrangements.map((arr, i) => {
    // The AI will say "Option 1: everyone arrives at 10:00 AM, done by 11:30 AM"
    const startTime = utcMsToSalonHm24(arr.groupStartMs, ctx.timezone);
    const endTime   = utcMsToSalonHm24(arr.groupEndMs,   ctx.timezone);
    const summary =
      mode === "sync_finish"
        ? `${totalMembers} people finish together at ${arr.groupEndDisplay}. Services start as early as ${arr.groupStartDisplay}.`
        : `${totalMembers} people arrive and start together at ${arr.groupStartDisplay}, done by ${arr.groupEndDisplay}.`;
    return {
      index:            i,
      startDisplay:     arr.groupStartDisplay,
      endDisplay:       arr.groupEndDisplay,
      startTime,  // HH:MM 24h — pass back in confirm_group_booking
      endTime,
      summary,
    };
  });

  return NextResponse.json({
    arrangements: voiceArrangements,
    count:        voiceArrangements.length,
    date:         dateYmd,
    mode,
    totalMembers,
    hint:         "Present at most 2 options to the customer. Say the time clearly. When confirmed, call confirm_group_booking.",
  });
}

// ─── confirm_group_booking ───────────────────────────────────────

/**
 * Re-runs the scheduler at the chosen time, inserts group bookings via the
 * insert_group_bookings RPC, creates a Party Link, and returns success data.
 */
async function handleConfirmGroupBooking(
  supabase: ReturnType<typeof createServiceRoleClient>,
  salonSlug: string,
  args: Record<string, unknown>,
  sessionId: string | null,
  req: NextRequest,
) {
  // 1. Parse args
  const serviceAssignments = args.service_assignments as { service_id: string; count: number }[] | undefined;
  const dateYmd         = args.date           as string | undefined;
  const chosenTime      = args.time           as string | undefined;   // HH:MM 24h
  const mode            = ((args.mode as string | undefined) ?? "sync_start") as GroupSyncMode;
  const organizerName   = args.organizer_name  as string | undefined;
  const organizerPhone  = args.organizer_phone as string | undefined;

  if (!Array.isArray(serviceAssignments) || serviceAssignments.length === 0) {
    return NextResponse.json({ error: "missing_service_assignments" }, { status: 400 });
  }
  if (!dateYmd || !/^\d{4}-\d{2}-\d{2}$/.test(dateYmd)) {
    return NextResponse.json({ error: "invalid_date" }, { status: 400 });
  }
  if (!chosenTime) {
    return NextResponse.json({ error: "missing_time: pass the chosen HH:MM from get_group_available_slots" }, { status: 400 });
  }
  const chosenMin = parseHm24(chosenTime);
  if (chosenMin === null) {
    return NextResponse.json({ error: "invalid_time: expected HH:MM (24h)" }, { status: 400 });
  }
  if (!organizerName?.trim()) {
    return NextResponse.json({ error: "missing_organizer_name" }, { status: 400 });
  }
  if (!organizerPhone?.trim()) {
    return NextResponse.json({ error: "missing_organizer_phone" }, { status: 400 });
  }

  // 2. Validate phone
  const phoneResult = validateGuestPhone(organizerPhone.trim());
  if (!phoneResult.ok) {
    return NextResponse.json({ error: "invalid_organizer_phone", detail: "Phone number format not recognised." }, { status: 400 });
  }
  const phoneDigits = phoneResult.digits;

  // 3. Load scheduling context (same as get_group_available_slots)
  const ctxOrErr = await loadGroupCtx(supabase, salonSlug, serviceAssignments, dateYmd);
  if ("error" in ctxOrErr) {
    return NextResponse.json({ error: ctxOrErr.error }, { status: ctxOrErr.status });
  }
  const ctx = ctxOrErr;

  // 4. Re-run scheduler at the chosen anchor to get concrete staff assignments
  //    (Ensures we pick up any bookings created since get_group_available_slots was called)
  const anchorMs   = Date.parse(salonWallTimeToUtcIso(dateYmd, chosenMin, ctx.timezone));
  const openMin    = parseHm24(ctx.dayHours.open)  ?? 0;
  const closeMin   = parseHm24(ctx.dayHours.close) ?? 0;
  const dayOpenMs  = Date.parse(salonWallTimeToUtcIso(dateYmd, openMin,  ctx.timezone));
  const dayCloseMs = Date.parse(salonWallTimeToUtcIso(dateYmd, closeMin, ctx.timezone));

  let finalArrangement: GroupArrangement | null = null;
  // Unified assignment list — each carries waveNumber (1 for normal bookings,
  // 2/3… for later waves of a large group split across time).
  let finalAssignments: WaveRawAssignment[] = [];

  if (mode === "sync_finish") {
    // For sync_finish the chosen time is the finish time. Wave splitting is NOT
    // supported for sync_finish this phase (get_group_available_slots already
    // returns the "use arrive together" message for large finish-together groups).
    const finishResults = findFinishArrangementsInWindow({
      targetFinishMs:  anchorMs,
      dayOpenMs,
      dayCloseMs,
      date:            dateYmd,
      timezone:        ctx.timezone,
      resolvedMembers: ctx.resolvedMembers,
      staffList:       ctx.staffList,
      staffById:       ctx.staffById,
      capability:      ctx.capability,
      existing:        ctx.existing,
    });
    if (finishResults.length === 0) {
      return NextResponse.json({
        ok:     false,
        reason: "slot_no_longer_available",
        message: "The requested group time is no longer available. Please call get_group_available_slots again to find the next available slot.",
      }, { status: 409 });
    }
    finalArrangement = finishResults[0]!;
    finalAssignments = finalArrangement.assignments.map((a) => ({
      memberIdx:  a.memberIndex,
      staffId:    a.staffId,
      startMs:    Date.parse(a.startUtcIso),
      endMs:      Date.parse(a.endUtcIso),
      waveNumber: 1,
    }));
  } else {
    // sync_start: try the whole group simultaneously first (unchanged behaviour).
    const aligned = tryAlignedArrangement(
      anchorMs,
      ctx.resolvedMembers,
      ctx.staffList,
      ctx.staffById,
      ctx.capability,
      ctx.existing,
      false,
    );
    if (aligned) {
      finalArrangement = buildArrangement("best", aligned, ctx.resolvedMembers, ctx.staffById, ctx.timezone);
      finalAssignments = aligned.assignments.map((a) => ({ ...a, waveNumber: 1 }));
    } else {
      // Wave fallback (Phase 6): the group can't all start at once → split into waves.
      const waveRaw = tryWaveArrangement(
        anchorMs, ctx.resolvedMembers, ctx.staffList, ctx.staffById,
        ctx.capability, ctx.existing, dayCloseMs,
      );
      if (waveRaw && waveRaw.assignments.length === ctx.resolvedMembers.length) {
        finalArrangement = buildWaveArrangement(waveRaw, ctx.resolvedMembers, ctx.staffById, ctx.timezone);
        finalAssignments = waveRaw.assignments;
      } else {
        return NextResponse.json({
          ok:     false,
          reason: "slot_no_longer_available",
          message: "The requested group time is no longer available. Please call get_group_available_slots again to find the next available slot.",
        }, { status: 409 });
      }
    }
  }

  // 5. Build the insert_group_bookings payload
  //    Part A: use Guest N placeholders — real names come from Party Link claiming.
  //    Guest numbering follows wave order so wave 1 = Guest 1…k, wave 2 = Guest k+1…
  const idempotencyKey = crypto.randomUUID();
  const orderedAssignments = finalAssignments
    .slice()
    .sort((a, b) => a.waveNumber - b.waveNumber || a.memberIdx - b.memberIdx);
  const insertPayload = orderedAssignments.map((a, idx) => {
    const member = ctx.resolvedMembers.find((m) => m.index === a.memberIdx) ?? ctx.resolvedMembers[idx]!;
    const svc    = ctx.serviceById.get(member.serviceId)!;
    return {
      salon_id:                  ctx.salonId,
      staff_id:                  a.staffId,
      service_id:                member.serviceId,
      client_name:               `Guest ${idx + 1}`,
      client_phone:              phoneDigits,
      client_email:              null,
      client_notes:              "Voice group booking",
      start_time_utc:            new Date(a.startMs).toISOString(),
      end_time_utc:              new Date(a.endMs).toISOString(),
      price_cents:               svc.priceCents,
      wave_number:               a.waveNumber,
      staff_requested_by_client: false,
      idempotency_key:           idempotencyKey,
    };
  });

  // 6. Atomic insert via RPC
  const { data: rpcData, error: rpcErr } = await supabase.rpc("insert_group_bookings", {
    p_bookings: insertPayload,
  });

  if (rpcErr) {
    console.error("[voice/confirm_group_booking] RPC error:", rpcErr);
    const e = rpcErr as { code?: string; message?: string };
    if (e.code === "23P01") {
      return NextResponse.json({
        ok:     false,
        reason: "slot_conflict",
        message: "A booking conflict occurred. Please call get_group_available_slots again to find fresh availability.",
      }, { status: 409 });
    }
    if (e.code === "23505") {
      return NextResponse.json({ ok: false, reason: "duplicate_submission" }, { status: 409 });
    }
    return NextResponse.json({ error: "group_booking_failed", detail: e.message }, { status: 500 });
  }

  const result = rpcData as { success?: boolean; code?: string; group_id?: string; booking_ids?: string[] } | null;
  if (!result?.success) {
    const code = result?.code ?? "unknown";
    if (code === "slot_conflict") {
      return NextResponse.json({
        ok:     false,
        reason: "slot_conflict",
        message: "A booking conflict occurred. Please call get_group_available_slots again.",
      }, { status: 409 });
    }
    if (code === "duplicate_submission") {
      return NextResponse.json({ ok: false, reason: "duplicate_submission" }, { status: 409 });
    }
    return NextResponse.json({ error: "group_booking_failed", code }, { status: 500 });
  }

  const groupId    = result.group_id!;
  const bookingIds = (result.booking_ids ?? []).map(String);

  // 7. Stamp source = "voice" on all created bookings (best-effort)
  if (bookingIds.length > 0) {
    try {
      await supabase
        .from("bookings")
        .update({ source: "voice", booking_channel: "voice" } as never)
        .in("id", bookingIds);
    } catch { /* best-effort */ }
    bookingIds.forEach((id) =>
      void logBookingEvent({
        bookingId: id,
        salonId: ctx.salonId,
        actorUserId: null,
        actorRole: "system",
        eventType: "booking_created",
        payload: { source: "voice_group", memberCount: bookingIds.length },
      }),
    );
    // Unified no-show protection gate — runs AI agent when opted-in, falls
    // back to hard rules otherwise.  Flag the lead (only it carries a phone).
    try {
      const { handleBookingProtection } = await import(
        "@/shared/noshow/handleBookingProtection"
      );
      await handleBookingProtection(bookingIds[0], ctx.salonId, "voice");
    } catch { /* best-effort */ }
    // Owner/admin "new booking" alert — one email for the group (first booking).
    if (bookingIds[0]) {
      void sendOwnerBookingNotification({
        salonId: ctx.salonId,
        bookingId: bookingIds[0],
        event: "new",
      });
    }
  }

  // 8. Create Party Link (best-effort — failure doesn't break the booking)
  let partyLinkUrl: string | null = null;
  try {
    const baseUrl = new URL(req.url).origin;
    const groupStartUtcIso = new Date(finalArrangement.groupStartMs).toISOString();
    const linkResult = await createPartyLink({
      groupId,
      salonId:         ctx.salonId,
      bookingIds,
      mode,
      groupStartUtcIso,
      baseUrl,
      organizerName:   organizerName!.trim(),
      organizerPhone:  phoneDigits,
    });
    if (linkResult.ok) partyLinkUrl = linkResult.url;
  } catch {
    // Party Link creation failing must not break the group booking confirmation.
    console.warn("[voice/confirm_group_booking] Party Link creation failed (non-fatal).");
  }

  // 9. Link to voice_ai_session (best-effort)
  if (sessionId) {
    try {
      await supabase
        .from("voice_ai_sessions")
        .update({ status: "completed" })
        .eq("id", sessionId);
    } catch { /* best-effort */ }
  }

  // 10. Send ONE confirmation SMS to the ORGANIZER — AWAITED so we report the
  //     real result. Previously group bookings sent NO SMS at all, yet the UI
  //     claimed "SMS sent". We mirror the individual-booking confirmation: a
  //     single SMS to the organizer (the only person whose phone we collected).
  //     Guests have placeholder names/no phones, so they are never messaged here.
  //     SMS failure never fails the booking.
  const totalMembers = ctx.resolvedMembers.length;
  let smsSent = false;
  const firstBookingId = bookingIds[0] ?? null;
  if (firstBookingId) {
    try {
      const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
      const smsRes = await fetch(`${appUrl}/api/booking/sms-confirm`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookingId:    firstBookingId,
          salonId:      ctx.salonId,
          clientPhone:  phoneDigits,
          clientName:   organizerName!.trim(),
          serviceName:  `Group of ${totalMembers}`,
          startTimeUtc: new Date(finalArrangement.groupStartMs).toISOString(),
        }),
      });
      const smsJson = await smsRes.json().catch(() => ({})) as { ok?: boolean; error?: string };
      smsSent = smsRes.ok && smsJson.ok === true;
      if (!smsSent) {
        console.warn("[voice/confirm_group_booking] confirmation SMS not sent:", smsJson.error ?? `http_${smsRes.status}`);
      }
    } catch (e: unknown) {
      console.error("[voice/confirm_group_booking] sms-confirm dispatch failed", e);
      smsSent = false;
    }
  }

  return NextResponse.json({
    ok:                true,
    groupId,
    bookingIds,
    partyLinkUrl,
    smsSent,
    // Phase 6 wave info — true + waveCount>1 when the large group was split.
    isWaveBooking:     finalArrangement.isWaveBooking,
    waveCount:         finalArrangement.waveCount,
    waves:             finalArrangement.waves.map((w) => ({
      waveNumber:   w.waveNumber,
      startDisplay: w.startDisplay,
      endDisplay:   w.endDisplay,
      memberCount:  w.memberCount,
    })),
    groupStartDisplay: finalArrangement.groupStartDisplay,
    groupEndDisplay:   finalArrangement.groupEndDisplay,
    groupStartTime:    utcMsToSalonHm24(finalArrangement.groupStartMs, ctx.timezone),
    groupEndTime:      utcMsToSalonHm24(finalArrangement.groupEndMs,   ctx.timezone),
    date:              dateYmd,
    totalMembers,
    organizerName:     organizerName!.trim(),
    message:           finalArrangement.isWaveBooking
      ? `Group booking confirmed for ${totalMembers} people across ${finalArrangement.waveCount} waves. Party link is ready to share.`
      : (partyLinkUrl
          ? `Group booking confirmed for ${totalMembers} people. Party link is ready to share.`
          : `Group booking confirmed for ${totalMembers} people.`),
    hint: finalArrangement.isWaveBooking
      ? "WAVE booking confirmed. Tell the organizer their group is split into waves (say each wave's start time and guest count from `waves`). Do NOT read individual staff assignments. Mention the party link will be shared."
      : "Do NOT read individual staff assignments aloud. Tell the customer the group start time, end time, and that the party link will be shared with the group organizer.",
  });
}
