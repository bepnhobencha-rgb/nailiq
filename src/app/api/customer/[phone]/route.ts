import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  clientIp,
  durableRateLimitKey,
  isOverRateLimit,
} from "@/shared/lib/inAppRateLimit";

// ---------------------------------------------------------------------------
// GET /api/customer/[phone]?salon_id=<uuid>
//
// PRE-AUTH RECOGNITION ONLY. This endpoint is PUBLIC and UNAUTHENTICATED, so it
// must never return the customer's PII. It answers a single low-sensitivity
// question — "has this phone booked here before, and is it a VIP?" — used to
// show a warm generic "Welcome back!" at the booking gate.
//
// It deliberately does NOT return name, visit count, usual technician, email,
// or last-booking details. Returning any of those let anyone type a phone
// number and read the owner's real identity + visit history (PII enumeration —
// QA S1). The personalization (name auto-fill, "rebook with your usual tech")
// must come from a POST-verification fetch once the customer proves they own
// the phone via OTP — not from this anonymous lookup.
// ---------------------------------------------------------------------------

export type CustomerLookupHit = { found: true; isVip: boolean };
export type CustomerLookupResponse = CustomerLookupHit | { found: false };

// Simple UUID v4 / UUID-like validation (36 chars, hex + dashes)
const UUID_REGEX = /^[0-9a-f-]{36}$/i;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ phone: string }> },
) {
  // 0. Rate-limit — bulk-enumeration defence. DB-backed (atomic fixed-window
  // via the `rate_limit_hit` RPC) so it actually enforces on any Vercel plan,
  // unlike the WAF hook which is a no-op until a dashboard rule exists. A legit
  // booking calls this a handful of times; a scraper hits it continuously.
  // Fails closed on a limiter outage: pre-auth enumeration is not allowed to
  // bypass its only durable server-side control.
  const ip = clientIp(_req);
  // A full Playwright shard makes many legitimate requests from one loopback
  // IP. Bypass only in the isolated GitHub E2E runtime; Vercel can never meet
  // this guard, even if a test flag is copied into its environment by mistake.
  const bypassRateLimitForE2E =
    process.env.CI === "true" &&
    process.env.NAILIQ_TEST_BYPASS_SLUG_PIN === "1" &&
    process.env.DISABLE_OUTBOUND_SMS === "1" &&
    !process.env.VERCEL;
  if (
    !bypassRateLimitForE2E &&
    (await isOverRateLimit(durableRateLimitKey("customer-lookup", ip), 30, 60, {
      failureMode: "block",
    }))
  ) {
    return NextResponse.json<CustomerLookupResponse>(
      { found: false },
      { status: 429 },
    );
  }

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
      .select("id, archived_at")
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

    // 4. Look up the client profile by phone (global — cross-salon by design).
    // Only `is_vip` is surfaced; name/history are intentionally NOT selected.
    const { data: profileData, error: profileError } = await supabase
      .from("client_profiles")
      .select("is_vip, deleted_at")
      .eq("phone", phoneDigits)
      .is("deleted_at", null)
      .maybeSingle();

    if (profileError) {
      console.error("[customer-lookup] profile query error", profileError);
      return NextResponse.json<CustomerLookupResponse>({ found: false });
    }

    if (profileData) {
      return NextResponse.json<CustomerLookupResponse>({
        found: true,
        isVip: (profileData as { is_vip?: boolean }).is_vip ?? false,
      });
    }

    // 5. Fallback recognition: a customer served only at the DESK (or imported
    // from Square/Wix) has bookings but NO client_profiles row — that table is
    // only written by the online flow. Recognise them so a generic "Welcome
    // back!" still shows. No PII is returned (isVip stays false).
    const { data: anyRow } = await supabase
      .from("bookings")
      .select("id")
      .eq("salon_id", salonId)
      .eq("client_phone", phoneDigits)
      .not("status", "eq", "cancelled")
      .limit(1);

    if (!anyRow || anyRow.length === 0) {
      return NextResponse.json<CustomerLookupResponse>({ found: false });
    }

    return NextResponse.json<CustomerLookupResponse>({
      found: true,
      isVip: false,
    });
  } catch (e) {
    console.error("[customer-lookup] unexpected error", e);
    // Fail safe — never expose internal errors to public callers
    return NextResponse.json<CustomerLookupResponse>({ found: false });
  }
}
