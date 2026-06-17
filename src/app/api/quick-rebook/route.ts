import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";
import { serviceBlockMinutes } from "@/shared/booking/bookingBlock";

export const dynamic = "force-dynamic";

// ────────────────────────────────────────────────────────────
// GET /api/quick-rebook?salon_id=X&phone=Y
// Returns the customer's booking pattern if confidence ≥ 0.70
// and last booking was < 6 months ago.
// ────────────────────────────────────────────────────────────
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const salonId = searchParams.get("salon_id")?.trim();
  const phone = searchParams.get("phone")?.trim();

  if (!salonId || !phone) {
    return NextResponse.json({ available: false, error: "missing_params" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  const { data: pattern } = await supabase
    .from("customer_booking_patterns")
    .select(
      "id, pattern_confidence, recurring_weekday, recurring_hour, usual_service_ids, usual_staff_id, last_booking_at, recurrence_frequency_days, usual_total_cents",
    )
    .eq("salon_id", salonId)
    .eq("client_phone", phone)
    .maybeSingle();

  if (!pattern) {
    return NextResponse.json({ available: false });
  }

  // Must have confidence ≥ 0.70
  if (!pattern.pattern_confidence || pattern.pattern_confidence < 0.7) {
    return NextResponse.json({ available: false });
  }

  // Last booking must be within 6 months
  if (pattern.last_booking_at) {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    if (new Date(pattern.last_booking_at) < sixMonthsAgo) {
      return NextResponse.json({ available: false });
    }
  } else {
    return NextResponse.json({ available: false });
  }

  // Resolve service name for the first usual service
  let serviceName: string | null = null;
  let servicePriceCents: number | null = null;
  const usualServiceId =
    Array.isArray(pattern.usual_service_ids) && pattern.usual_service_ids.length > 0
      ? pattern.usual_service_ids[0]
      : null;

  if (usualServiceId) {
    const { data: svc } = await supabase
      .from("services")
      .select("name, price_cents")
      .eq("id", usualServiceId)
      .maybeSingle();
    if (svc) {
      serviceName = svc.name;
      servicePriceCents = svc.price_cents;
    }
  }

  // Resolve staff name
  let staffName: string | null = null;
  if (pattern.usual_staff_id) {
    const { data: staff } = await supabase
      .from("staff")
      .select("name")
      .eq("id", pattern.usual_staff_id)
      .maybeSingle();
    staffName = staff?.name ?? null;
  }

  // Map weekday index to readable name (Sunday = 0)
  const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const weekdayName =
    pattern.recurring_weekday !== null && pattern.recurring_weekday !== undefined
      ? WEEKDAY_NAMES[pattern.recurring_weekday] ?? null
      : null;

  const hourLabel =
    pattern.recurring_hour !== null && pattern.recurring_hour !== undefined
      ? formatHour(pattern.recurring_hour)
      : null;

  return NextResponse.json({
    available: true,
    pattern: {
      confidence: pattern.pattern_confidence,
      recurring_weekday: pattern.recurring_weekday,
      weekday_name: weekdayName,
      recurring_hour: pattern.recurring_hour,
      hour_label: hourLabel,
      usual_service_id: usualServiceId,
      service_name: serviceName,
      service_price_cents: servicePriceCents,
      usual_staff_id: pattern.usual_staff_id,
      staff_name: staffName,
      recurrence_frequency_days: pattern.recurrence_frequency_days,
      usual_total_cents: pattern.usual_total_cents,
      last_booking_at: pattern.last_booking_at,
    },
  });
}

// ────────────────────────────────────────────────────────────
// POST /api/quick-rebook
// Body: { salon_id, phone }
// Finds the next available slot matching usual weekday/hour
// and calls create_public_booking RPC.
// ────────────────────────────────────────────────────────────
export async function POST(req: Request) {
  let body: { salon_id?: string; phone?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { salon_id: salonId, phone } = body;
  if (!salonId || !phone) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  // Re-fetch the pattern (server-side trust — don't rely on client)
  const { data: pattern } = await supabase
    .from("customer_booking_patterns")
    .select(
      "pattern_confidence, recurring_weekday, recurring_hour, usual_service_ids, usual_staff_id, last_booking_at",
    )
    .eq("salon_id", salonId)
    .eq("client_phone", phone)
    .maybeSingle();

  if (!pattern || !pattern.pattern_confidence || pattern.pattern_confidence < 0.7) {
    return NextResponse.json({ error: "no_pattern" }, { status: 400 });
  }

  const usualServiceId =
    Array.isArray(pattern.usual_service_ids) && pattern.usual_service_ids.length > 0
      ? pattern.usual_service_ids[0]
      : null;

  if (!usualServiceId) {
    return NextResponse.json({ error: "no_service" }, { status: 400 });
  }

  // Fetch service duration to compute end_time
  const { data: service } = await supabase
    .from("services")
    .select("id, name, price_cents, duration_minutes, buffer_minutes")
    .eq("id", usualServiceId)
    .maybeSingle();

  if (!service) {
    return NextResponse.json({ error: "service_not_found" }, { status: 404 });
  }

  // Fetch client name
  const { data: profile } = await supabase
    .from("client_profiles")
    .select("name")
    .eq("phone", phone)
    .maybeSingle();

  const clientName = profile?.name ?? "Customer";

  // Find next slot matching preferred weekday and hour
  // Search up to 8 weeks ahead
  const slot = await findNextAvailableSlot(supabase, {
    salonId,
    preferredWeekday: pattern.recurring_weekday,
    preferredHour: pattern.recurring_hour ?? 10,
    staffId: pattern.usual_staff_id ?? null,
    durationMinutes: serviceBlockMinutes(service.duration_minutes, service.buffer_minutes),
  });

  if (!slot) {
    return NextResponse.json({ error: "no_available_slot" }, { status: 409 });
  }

  const endTimeUtc = new Date(
    new Date(slot.start).getTime() + service.duration_minutes * 60_000,
  ).toISOString();

  const { data: booking, error: bookingError } = await supabase.rpc(
    "create_public_booking",
    {
      p_salon_id: salonId,
      p_service_id: service.id,
      p_staff_id: slot.staffId ?? pattern.usual_staff_id ?? "",
      p_start_time_utc: slot.start,
      p_end_time_utc: endTimeUtc,
      p_client_name: clientName,
      p_client_phone: toCanonicalPhone(phone) ?? phone,
      p_price_cents: service.price_cents,
      p_status: "confirmed",
    },
  );

  if (bookingError || !booking) {
    console.error("[quick-rebook] create_public_booking failed:", bookingError);
    return NextResponse.json({ error: "booking_failed" }, { status: 500 });
  }

  // Resolve staff name
  let staffName: string | null = null;
  if (slot.staffId) {
    const { data: staffRow } = await supabase
      .from("staff")
      .select("name")
      .eq("id", slot.staffId)
      .maybeSingle();
    staffName = staffRow?.name ?? null;
  }

  const bookingId =
    typeof booking === "object" && booking !== null && "booking_id" in booking
      ? (booking as { booking_id: string }).booking_id
      : String(booking);

  // Stamp booking_channel = 'online' (customer-initiated rebook). Best-effort;
  // the RPC leaves it null.
  if (bookingId) {
    try {
      await supabase
        .from("bookings")
        .update({ booking_channel: "online" } as never)
        .eq("id", bookingId);
    } catch {
      /* best-effort */
    }
    // Unified no-show card gate (quick-rebook creates without a card capture).
    try {
      const { ensureNoShowCardRequirement } = await import(
        "@/shared/noshow/ensureNoShowCardRequirement"
      );
      await ensureNoShowCardRequirement(bookingId);
    } catch {
      /* best-effort */
    }
  }

  return NextResponse.json({
    ok: true,
    booking_id: bookingId,
    start_time_utc: slot.start,
    end_time_utc: endTimeUtc,
    service_name: service.name,
    staff_name: staffName,
  });
}

// ─── helpers ────────────────────────────────────────────────

function formatHour(hour: number): string {
  if (hour === 0) return "12:00 AM";
  if (hour === 12) return "12:00 PM";
  const suffix = hour < 12 ? "AM" : "PM";
  const h = hour > 12 ? hour - 12 : hour;
  return `${h}:00 ${suffix}`;
}

type SlotResult = { start: string; staffId: string | null } | null;

async function findNextAvailableSlot(
  supabase: ReturnType<typeof createServiceRoleClient>,
  opts: {
    salonId: string;
    preferredWeekday: number | null;
    preferredHour: number;
    staffId: string | null;
    durationMinutes: number;
  },
): Promise<SlotResult> {
  const { salonId, preferredWeekday, preferredHour, staffId, durationMinutes } = opts;

  // Look at salon opening hours to determine valid start time
  const { data: salon } = await supabase
    .from("salons")
    .select("opening_hours, timezone")
    .eq("id", salonId)
    .maybeSingle();

  const tz = salon?.timezone ?? "America/Vancouver";

  // Search up to 8 weeks ahead, checking each candidate weekday
  const now = new Date();
  const searchEnd = new Date(now.getTime() + 56 * 24 * 60 * 60 * 1000);

  // Start from tomorrow
  const cursor = new Date(now);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  cursor.setUTCHours(0, 0, 0, 0);

  while (cursor < searchEnd) {
    // Check if this day matches preferred weekday (or any if no preference)
    const dayOfWeek = new Date(
      cursor.toLocaleString("en-US", { timeZone: tz }),
    ).getDay();

    const dayMatches =
      preferredWeekday === null || preferredWeekday === undefined || dayOfWeek === preferredWeekday;

    if (dayMatches) {
      // Build candidate slot at preferred hour in salon timezone
      const localDateStr = cursor.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
      const candidateLocal = new Date(
        `${localDateStr}T${String(preferredHour).padStart(2, "0")}:00:00`,
      );

      // Convert to UTC by computing the offset
      const salonDateStr = candidateLocal.toLocaleString("en-US", { timeZone: tz });
      const salonDate = new Date(salonDateStr);
      const offsetMs = salonDate.getTime() - candidateLocal.getTime();
      const candidateUtc = new Date(candidateLocal.getTime() - offsetMs);

      if (candidateUtc > now) {
        const startUtc = candidateUtc.toISOString();
        const endUtc = new Date(candidateUtc.getTime() + durationMinutes * 60_000).toISOString();

        // Check occupancy for this slot
        const { data: occupancy } = await supabase.rpc(
          "public_booking_occupancy_for_range",
          {
            p_salon_id: salonId,
            p_start: startUtc,
            p_end: endUtc,
          },
        );

        const occupied = (occupancy ?? []) as Array<{
          staff_id: string;
          start_time_utc: string;
          end_time_utc: string;
        }>;

        // If a specific staff is preferred, check if they're free
        if (staffId) {
          const staffBusy = occupied.some((o) => o.staff_id === staffId);
          if (!staffBusy) {
            return { start: startUtc, staffId };
          }
        } else if (occupied.length === 0) {
          // No staff preference and no conflicts
          return { start: startUtc, staffId: null };
        }
      }
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return null;
}
