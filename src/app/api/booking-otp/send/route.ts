import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { sendVerification } from "@/shared/lib/twilioVerify";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";

export async function POST(req: Request) {
  let body: { phone?: string; shopSlug?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const phone = (body.phone ?? "").trim();
  const shopSlug = (body.shopSlug ?? "").trim();
  if (!phone || !shopSlug) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const phoneOk = validateGuestPhone(phone);
  if (!phoneOk.ok) {
    return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data: salon } = await supabase
    .from("salons")
    .select("id, name, phone_otp_enabled")
    .eq("slug", shopSlug)
    .maybeSingle();

  const salonRow = salon as unknown as {
    name?: string | null;
    phone_otp_enabled: boolean;
  } | null;
  if (!salonRow || !salonRow.phone_otp_enabled) {
    return NextResponse.json({ error: "otp_not_enabled" }, { status: 400 });
  }

  // Demo/E2E mode: skip real SMS, accept code 000000 in verify.
  if (isDemoOtpRuntime()) {
    return NextResponse.json({ ok: true });
  }

  const e164 = `+${phoneOk.digits}`;
  // Show the salon's own name in the OTP message instead of the generic Verify
  // Service name, so the customer recognizes who's texting them.
  const result = await sendVerification(e164, salonRow.name ?? undefined);

  if (!result.ok) {
    console.error("[booking-otp/send] sendVerification failed", result.error);
    return NextResponse.json(
      { error: result.error ?? "send_failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
