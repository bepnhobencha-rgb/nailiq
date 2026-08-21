import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/shared/lib/supabase/server";
import { consumePublicRequestRateLimit } from "@/shared/security/publicServerActionRateLimit";

const MIN_BOOKINGS = 5;
const TOP_N = 3;

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const salonId = searchParams.get("salon_id");
  const serviceId = searchParams.get("service_id");

  if (!salonId) {
    return NextResponse.json({ error: "salon_id required" }, { status: 400 });
  }

  const rate = await consumePublicRequestRateLimit({
    request: req,
    scope: "booking-slot-ranking",
    identity: [salonId, serviceId ?? "all-services"],
    ipLimits: [[60, 60], [300, 3_600]],
    identityLimits: [[120, 60], [1_000, 3_600]],
  });
  if (rate !== "allowed") {
    return NextResponse.json(
      { error: rate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      { status: rate === "limited" ? 429 : 503 },
    );
  }

  const db = await createClient();

  const { data: salon } = await db
    .from("salons")
    .select("timezone")
    .eq("id", salonId)
    .maybeSingle();

  const timezone = salon?.timezone ?? "America/Vancouver";

  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  let query = db
    .from("bookings")
    .select("start_time_utc")
    .eq("salon_id", salonId)
    .in("status", ["confirmed", "completed"])
    .gte("start_time_utc", ninetyDaysAgo)
    .limit(500);

  if (serviceId) {
    query = query.eq("service_id", serviceId);
  }

  const { data: bookings } = await query;

  if (!bookings?.length || bookings.length < MIN_BOOKINGS) {
    return NextResponse.json({ popularLabels: [] });
  }

  // Tally by time-of-day label in salon's local timezone
  const tally = new Map<string, number>();
  for (const row of bookings) {
    const label = new Date(row.start_time_utc).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: timezone,
    });
    tally.set(label, (tally.get(label) ?? 0) + 1);
  }

  const popularLabels = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N)
    .map(([label]) => label);

  return NextResponse.json({ popularLabels });
}
