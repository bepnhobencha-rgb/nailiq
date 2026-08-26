import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { consumePublicRequestRateLimit } from "@/shared/security/publicServerActionRateLimit";

// GET /api/customer/profile-verified?otp_session_id=&phone=&salon_id=
// Validates an active (unconsumed, unexpired) OTP session, then returns the
// full customer profile for that phone. Unlike the unauthenticated /api/customer/[phone]
// endpoint, this returns PII (name, email, visit history) because the caller has
// already proved phone ownership via the OTP flow.
// The session is NOT consumed here — consumption happens at booking commit.
export async function GET(req: Request) {
  const ipRate = await consumePublicRequestRateLimit({
    request: req,
    scope: "customer-profile-verified",
    ipLimits: [[30, 60], [120, 3_600]],
  });
  if (ipRate !== "allowed") {
    return NextResponse.json(
      { found: false, error: ipRate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      { status: ipRate === "limited" ? 429 : 503 },
    );
  }
  const { searchParams } = new URL(req.url);
  const otpSessionId = (searchParams.get("otp_session_id") ?? "").trim();
  const phone = (searchParams.get("phone") ?? "").trim();
  const salonId = (searchParams.get("salon_id") ?? "").trim();

  if (!otpSessionId || !phone || !salonId) {
    return NextResponse.json({ found: false, error: "missing_params" }, { status: 400 });
  }

  const phoneOk = validateGuestPhone(phone);
  if (!phoneOk.ok) {
    return NextResponse.json({ found: false, error: "invalid_phone" }, { status: 400 });
  }
  const phoneDigits = phoneOk.digits;

  const identityRate = await consumePublicRequestRateLimit({
    request: req,
    scope: "customer-profile-verified-identity",
    identity: [salonId, phoneDigits, otpSessionId],
    ipLimits: [],
    identityLimits: [[10, 900], [30, 86_400]],
  });
  if (identityRate !== "allowed") {
    return NextResponse.json(
      { found: false, error: identityRate === "limited" ? "rate_limited" : "temporarily_unavailable" },
      { status: identityRate === "limited" ? 429 : 503 },
    );
  }

  const supabase = createServiceRoleClient();

  // Validate the OTP session: must exist for this phone+salon, not consumed, not expired.
  const now = new Date().toISOString();
  const { data: session } = (await supabase
    .from("phone_otp_sessions" as never)
    .select("id" as never)
    .eq("id" as never, otpSessionId)
    .eq("phone" as never, phoneDigits)
    .eq("salon_id" as never, salonId)
    .is("consumed_at" as never, null)
    .gt("expires_at" as never, now)
    .maybeSingle()) as { data: { id: string } | null };

  if (!session) {
    return NextResponse.json({ found: false, error: "invalid_session" }, { status: 401 });
  }

  // Fetch profile + per-salon booking history in parallel.
  type ProfileRow = { name?: string | null; email?: string | null; is_vip?: boolean | null };
  type BookingRow = {
    status?: string | null;
    start_time_utc?: string | null;
    service_id?: string | null;
    staff_id?: string | null;
  };

  const [profileRes, bookingsRes] = await Promise.all([
    supabase
      .from("client_profiles")
      .select("name, email, is_vip" as never)
      .eq("phone" as never, phoneDigits)
      .is("deleted_at" as never, null)
      .maybeSingle() as unknown as Promise<{ data: ProfileRow | null }>,
    supabase
      .from("bookings")
      .select("status, start_time_utc, service_id, staff_id")
      .eq("salon_id", salonId)
      .eq("client_phone", phoneDigits) as unknown as Promise<{ data: BookingRow[] | null }>,
  ]);

  const profile = profileRes.data;
  const bookings = bookingsRes.data ?? [];

  // Per-salon aggregates.
  let visitCount = 0;
  let lastVisitAt: string | null = null;
  const serviceCounts = new Map<string, number>();
  const staffCounts = new Map<string, number>();
  let lastBookingRow: BookingRow | null = null;

  for (const b of bookings) {
    if ((b.status ?? "") === "cancelled") continue;
    visitCount += 1;
    const ts = b.start_time_utc?.trim() ?? null;
    if (ts && (lastVisitAt == null || ts > lastVisitAt)) {
      lastVisitAt = ts;
      lastBookingRow = b;
    }
    const sid = b.service_id?.trim();
    if (sid) serviceCounts.set(sid, (serviceCounts.get(sid) ?? 0) + 1);
    const stf = b.staff_id?.trim();
    if (stf) staffCounts.set(stf, (staffCounts.get(stf) ?? 0) + 1);
  }

  const hasProfile = !!profile;
  const hasHistory = visitCount > 0;
  if (!hasProfile && !hasHistory) {
    return NextResponse.json({ found: false });
  }

  function topId(map: Map<string, number>): string | null {
    let bestId: string | null = null;
    let bestCount = 0;
    for (const [id, count] of map) {
      if (count > bestCount) { bestId = id; bestCount = count; }
    }
    return bestId;
  }

  const topStaffId = topId(staffCounts);
  const topServiceId = topId(serviceCounts);

  // Resolve top service + staff names.
  type NameRow = { id: string; name: string | null } | null;
  const [topServiceRes, topStaffRes] = await Promise.all([
    topServiceId
      ? (supabase
          .from("services")
          .select("id, name")
          .eq("id", topServiceId)
          .eq("salon_id", salonId)
          .is("deleted_at" as never, null)
          .maybeSingle() as unknown as Promise<{ data: NameRow }>)
      : Promise.resolve({ data: null as NameRow }),
    topStaffId
      ? (supabase
          .from("staff")
          .select("id, name")
          .eq("id", topStaffId)
          .eq("salon_id", salonId)
          .is("deleted_at" as never, null)
          .maybeSingle() as unknown as Promise<{ data: NameRow }>)
      : Promise.resolve({ data: null as NameRow }),
  ]);

  const topService = topServiceRes.data;
  const topStaff = topStaffRes.data;

  const lastBookingServiceId = lastBookingRow?.service_id ?? topServiceId;
  const lastBookingStaffId = lastBookingRow?.staff_id ?? topStaffId;

  return NextResponse.json({
    found: true,
    isVip: profile?.is_vip === true,
    name: profile?.name?.trim() || undefined,
    email: profile?.email?.trim() || undefined,
    visitCount,
    preferredStaffId: topStaffId,
    preferredStaffName: topStaff?.name?.trim() ?? null,
    lastBooking:
      lastBookingServiceId && lastVisitAt
        ? {
            serviceId: lastBookingServiceId,
            serviceName: topService?.name?.trim() ?? "",
            staffId: lastBookingStaffId ?? null,
            staffName: topStaff?.name?.trim() ?? null,
            dayOfWeek: new Date(lastVisitAt).getDay(),
            timeLabel: new Date(lastVisitAt).toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
            }),
            lastVisitDate: lastVisitAt,
          }
        : null,
  });
}
