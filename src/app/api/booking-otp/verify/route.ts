import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { checkVerification } from "@/shared/lib/twilioVerify";
import { checkEmailOtp } from "@/shared/lib/emailOtp";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";
import {
  consumeDurableRateLimitBuckets,
  type DurableRateLimitResult,
} from "@/shared/security/publicServerActionRateLimit";
import { clientIp } from "@/shared/lib/inAppRateLimit";

function rateResponse(result: Exclude<DurableRateLimitResult, "allowed">) {
  return NextResponse.json(
    { error: result === "limited" ? "rate_limited" : "rate_limit_unavailable" },
    {
      status: result === "limited" ? 429 : 503,
      headers: { "Retry-After": result === "limited" ? "900" : "30" },
    },
  );
}

export async function POST(req: Request) {
  const ipRate = await consumeDurableRateLimitBuckets("booking-otp-verify", [
    { name: "ip-window", material: [clientIp(req)], limit: 60, windowSeconds: 900 },
  ]);
  if (ipRate !== "allowed") return rateResponse(ipRate);

  let body: { phone?: string; code?: string; shopSlug?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const phone = (body.phone ?? "").trim();
  const code = (body.code ?? "").replace(/\s/g, "");
  const shopSlug = (body.shopSlug ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();

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

  const identityRate = await consumeDurableRateLimitBuckets("booking-otp-verify", [
    { name: "phone-window", material: [phoneOk.digits], limit: 10, windowSeconds: 900 },
    { name: "phone-day", material: [phoneOk.digits], limit: 30, windowSeconds: 86_400 },
  ]);
  if (identityRate !== "allowed") return rateResponse(identityRate);

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
    // The customer typed ONE code — it may have arrived by SMS or by email
    // (both can be sent). Accept it if EITHER channel approves. Try SMS first
    // (most common), then the email-code store when an address is present.
    const e164 = `+${phoneOk.digits}`;
    const sms = await checkVerification(e164, code);
    let approved = sms.ok;
    let lastError = sms.error ?? "invalid_code";

    if (!approved && email) {
      const em = await checkEmailOtp({ salonId, phone: phoneOk.digits, email, code });
      approved = em.ok;
      if (!approved) lastError = em.error ?? lastError;
    }

    if (!approved) {
      const status = lastError === "expired_or_max_attempts" ? 410 : 400;
      return NextResponse.json({ error: lastError }, { status });
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
