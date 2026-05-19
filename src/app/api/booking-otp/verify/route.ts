import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { checkVerification } from "@/shared/lib/twilioVerify";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";

export async function POST(req: Request) {
  let body: { phone?: string; code?: string; shopSlug?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const phone = (body.phone ?? "").trim();
  const code = (body.code ?? "").replace(/\s/g, "");
  const shopSlug = (body.shopSlug ?? "").trim();

  if (!phone || !code || !shopSlug) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const phoneOk = validateGuestPhone(phone);
  if (!phoneOk.ok) {
    return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
  }

  if (!/^\d{4,8}$/.test(code)) {
    return NextResponse.json({ error: "invalid_code" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data: salon } = await supabase
    .from("salons")
    .select("id, phone_otp_enabled")
    .eq("slug", shopSlug)
    .maybeSingle();

  if (!salon || !(salon as unknown as { phone_otp_enabled: boolean }).phone_otp_enabled) {
    return NextResponse.json({ error: "otp_not_enabled" }, { status: 400 });
  }

  const salonId = String(salon.id);

  if (!isDemoOtpRuntime()) {
    const e164 = `+${phoneOk.digits}`;
    const result = await checkVerification(e164, code);

    if (!result.ok) {
      const errCode = result.error ?? "invalid_code";
      const status = errCode === "expired_or_max_attempts" ? 410 : 400;
      return NextResponse.json({ error: errCode }, { status });
    }
  } else if (code !== "000000") {
    // Demo mode: only accept the magic test code.
    return NextResponse.json({ error: "invalid_code" }, { status: 400 });
  }

  // Store a consumed-once session. The booking submission validates this row.
  const { data: session, error: insertErr } = await supabase
    .from("phone_otp_sessions")
    .insert({
      phone: phoneOk.digits,
      salon_id: salonId,
    } as never)
    .select("id")
    .single();

  if (insertErr || !session) {
    console.error("[booking-otp/verify] session insert failed", insertErr);
    return NextResponse.json({ error: "session_error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, sessionId: (session as { id: string }).id });
}
