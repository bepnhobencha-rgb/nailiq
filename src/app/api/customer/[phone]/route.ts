import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

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

    // 3. Verify salon exists and is not archived
    const { data: salon, error: salonError } = await supabase
      .from("salons")
      .select("id")
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

    // 6. Return safe subset — cap visitCount at 99 for display purposes
    const visitCount = Math.min(profile.visit_count ?? 0, 99);

    return NextResponse.json<CustomerLookupResponse>({
      found: true,
      name: profile.name ?? "",
      email: profile.email ?? null,
      isVip: profile.is_vip ?? false,
      visitCount,
      preferredStaffId,
      preferredStaffName,
    });
  } catch (e) {
    console.error("[customer-lookup] unexpected error", e);
    // Fail safe — never expose internal errors to public callers
    return NextResponse.json<CustomerLookupResponse>({ found: false });
  }
}
