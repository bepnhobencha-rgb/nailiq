import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { realNameOrEmpty } from "@/shared/booking/guestNamePlaceholder";

// ---------------------------------------------------------------------------
// Response types — exported so callers can import them
// ---------------------------------------------------------------------------

export type CustomerLookupHit = {
  found: true;
  name: string;
  email: string | null;
  isVip: boolean;
  visitCount: number;
  preferredStaffId: string | null;
  preferredStaffName: string | null;
  lastBooking: {
    serviceId: string;
    serviceName: string;
    staffId: string | null;
    staffName: string | null;
    /** 0=Sunday … 6=Saturday, in salon timezone */
    dayOfWeek: number;
    /** e.g. "11:00 AM" — formatted in salon timezone */
    timeLabel: string;
    /** ISO date string of the last visit */
    lastVisitDate: string;
  } | null;
};

export type CustomerLookupResponse = CustomerLookupHit | { found: false };

// ---------------------------------------------------------------------------
// Simple UUID v4 / UUID-like validation (36 chars, hex + dashes)
// ---------------------------------------------------------------------------
const UUID_REGEX = /^[0-9a-f-]{36}$/i;

// ---------------------------------------------------------------------------
// GET /api/customer/[phone]?salon_id=<uuid>
// ---------------------------------------------------------------------------

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ phone: string }> },
) {
  const { phone: rawPhone } = await params;
  const { searchParams } = new URL(_req.url);
  const salonId = searchParams.get("salon_id") ?? "";

  // 1. Strip phone to digits
  const phoneDigits = rawPhone.replace(/\D/g, "");
  if (phoneDigits.length < 7) {
    return NextResponse.json<CustomerLookupResponse>({ found: false });
  }

  // 2. Validate salon_id is a UUID-like string
  if (!UUID_REGEX.test(salonId)) {
    return NextResponse.json<CustomerLookupResponse>({ found: false });
  }

  try {
    const supabase = createServiceRoleClient();

    // 3. Verify salon exists and is not archived; also fetch timezone for formatting
    const { data: salon, error: salonError } = await supabase
      .from("salons")
      .select("id, archived_at, timezone")
      .eq("id", salonId)
      .is("archived_at", null)
      .maybeSingle();

    if (salonError) {
      console.error("[customer-lookup] salon query error", salonError);
      return NextResponse.json<CustomerLookupResponse>({ found: false });
    }
    if (!salon) {
      return NextResponse.json<CustomerLookupResponse>({ found: false });
    }

    // 4. Look up client profile by phone (global — cross-salon by design)
    const { data: profileData, error: profileError } = await supabase
      .from("client_profiles")
      .select("name, email, is_vip, visit_count, preferred_staff_id, deleted_at")
      .eq("phone", phoneDigits)
      .is("deleted_at", null)
      .maybeSingle();

    if (profileError) {
      console.error("[customer-lookup] profile query error", profileError);
      return NextResponse.json<CustomerLookupResponse>({ found: false });
    }

    // Cast to the subset we care about (deleted_at already filtered, not returned)
    const profile = profileData as {
      name: string | null;
      email: string | null;
      is_vip: boolean;
      visit_count: number | null;
      preferred_staff_id: string | null;
    } | null;

    if (!profile) {
      return NextResponse.json<CustomerLookupResponse>({ found: false });
    }

    // Capture salon timezone for date formatting (fallback to Vancouver as default)
    const salonTimezone =
      (salon as { timezone?: string }).timezone ?? "America/Vancouver";

    // 5. Optionally resolve preferred staff name (must belong to this salon)
    let preferredStaffId: string | null = profile.preferred_staff_id ?? null;
    let preferredStaffName: string | null = null;

    if (preferredStaffId) {
      const { data: staffData, error: staffError } = await supabase
        .from("staff")
        .select("id, name")
        .eq("id", preferredStaffId)
        .eq("salon_id", salonId)
        .is("deleted_at", null)
        .maybeSingle();

      if (staffError) {
        console.error("[customer-lookup] staff query error", staffError);
        // Non-fatal — just clear preferred staff
        preferredStaffId = null;
        preferredStaffName = null;
      } else if (!staffData) {
        // Staff belongs to a different salon or has been deleted
        preferredStaffId = null;
        preferredStaffName = null;
      } else {
        preferredStaffName = staffData.name;
      }
    }

    // 6. Query last completed booking for this phone + salon
    const { data: lastBookingRow } = await supabase
      .from("bookings")
      .select("service_id, staff_id, start_time_utc")
      .eq("salon_id", salonId)
      .eq("client_phone", phoneDigits)
      .eq("status", "completed")
      .order("start_time_utc", { ascending: false })
      .limit(1)
      .maybeSingle();

    const bRow = lastBookingRow as {
      service_id?: string | null;
      staff_id?: string | null;
      start_time_utc?: string | null;
    } | null;

    // 7. Resolve service name + staff name for last booking
    let lastBooking: CustomerLookupHit["lastBooking"] = null;

    if (bRow?.service_id && bRow?.start_time_utc) {
      // Resolve service name
      const { data: svc } = await supabase
        .from("services")
        .select("id, name")
        .eq("id", bRow.service_id)
        .maybeSingle();

      if (svc) {
        // Resolve staff name (must belong to this salon)
        let lastBookingStaffId: string | null = bRow.staff_id ?? null;
        let lastBookingStaffName: string | null = null;

        if (lastBookingStaffId) {
          const { data: stf } = await supabase
            .from("staff")
            .select("id, name")
            .eq("id", lastBookingStaffId)
            .eq("salon_id", salonId)
            .maybeSingle();

          if (stf) {
            lastBookingStaffName = stf.name;
          } else {
            // Staff not found in this salon — treat as no staff preference
            lastBookingStaffId = null;
          }
        }

        // Compute dayOfWeek and timeLabel in salon timezone
        const startDate = new Date(bRow.start_time_utc);
        const dayOfWeek = new Date(
          startDate.toLocaleString("en-US", { timeZone: salonTimezone }),
        ).getDay(); // 0=Sun … 6=Sat
        const timeLabel = startDate.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: salonTimezone,
        });

        lastBooking = {
          serviceId: bRow.service_id,
          serviceName: svc.name,
          staffId: lastBookingStaffId,
          staffName: lastBookingStaffName,
          dayOfWeek,
          timeLabel,
          lastVisitDate: bRow.start_time_utc,
        };
      }
    }

    // 8. Return safe subset — cap visitCount at 99 for display purposes
    const visitCount = Math.min(profile.visit_count ?? 0, 99);

    return NextResponse.json<CustomerLookupResponse>({
      found: true,
      // Never surface a "Guest N" / "Khách N" placeholder as the name —
      // those leaked into client_profiles from un-named group members.
      // Empty name → the UI treats them as "returning but needs a name".
      name: realNameOrEmpty(profile.name),
      email: profile.email ?? null,
      isVip: profile.is_vip ?? false,
      visitCount,
      preferredStaffId,
      preferredStaffName,
      lastBooking,
    });
  } catch (e) {
    console.error("[customer-lookup] unexpected error", e);
    // Fail safe — never expose internal errors to public callers
    return NextResponse.json<CustomerLookupResponse>({ found: false });
  }
}
