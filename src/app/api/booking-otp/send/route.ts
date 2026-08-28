import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { sendVerification } from "@/shared/lib/twilioVerify";
import { isValidEmailFormat } from "@/shared/lib/emailFormat";
import { createAndSendEmailOtp } from "@/shared/lib/emailOtp";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";
import {
  consumeDurableRateLimitBuckets,
  type DurableRateLimitResult,
} from "@/shared/security/publicServerActionRateLimit";
import { clientIp } from "@/shared/lib/inAppRateLimit";
import {
  completeBookingOtpDeliveryAttempt,
  createBookingOtpDeliveryAttempt,
} from "@/shared/booking/otpDeliveryTruth";

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
  const ipRate = await consumeDurableRateLimitBuckets("booking-otp-send", [
    { name: "ip-burst", material: [clientIp(req)], limit: 20, windowSeconds: 900 },
    { name: "ip-hour", material: [clientIp(req)], limit: 60, windowSeconds: 3_600 },
  ]);
  if (ipRate !== "allowed") return rateResponse(ipRate);

  let body: { phone?: string; shopSlug?: string; channel?: string; email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const phone = (body.phone ?? "").trim();
  const shopSlug = (body.shopSlug ?? "").trim();
  const channel = body.channel === "email" ? "email" : "sms";
  const email = (body.email ?? "").trim().toLowerCase();
  if (!phone || !shopSlug) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const phoneOk = validateGuestPhone(phone);
  if (!phoneOk.ok) {
    return NextResponse.json({ error: "invalid_phone" }, { status: 400 });
  }
  if (channel === "email" && !isValidEmailFormat(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  const identityRate = await consumeDurableRateLimitBuckets("booking-otp-send", [
    {
      name: "phone-window",
      material: [phoneOk.digits],
      limit: 5,
      windowSeconds: 900,
    },
    {
      name: "phone-day",
      material: [phoneOk.digits],
      limit: 10,
      windowSeconds: 86_400,
    },
  ]);
  if (identityRate !== "allowed") return rateResponse(identityRate);

  const supabase = createServiceRoleClient();
  const { data: salon } = await supabase
    .from("salons")
    .select("id, name, address, phone_otp_enabled, email_links_enabled")
    .eq("slug", shopSlug)
    .maybeSingle();

  const salonRow = salon as unknown as {
    id: string;
    name?: string | null;
    address?: string | null;
    phone_otp_enabled: boolean;
    email_links_enabled?: boolean | null;
  } | null;
  if (!salonRow || !salonRow.phone_otp_enabled) {
    return NextResponse.json({ error: "otp_not_enabled" }, { status: 400 });
  }

  // Demo/E2E mode: skip real sends, accept code 000000 in verify (both channels).
  if (isDemoOtpRuntime()) {
    return NextResponse.json({ ok: true });
  }

  // ── EMAIL channel (resilient fallback) ──────────────────────────────────
  if (channel === "email") {
    // Gated by the same per-salon email-channel master as the link emails.
    if (salonRow.email_links_enabled === false) {
      return NextResponse.json({ error: "email_channel_disabled" }, { status: 400 });
    }
    const result = await createAndSendEmailOtp({
      salonId: String(salonRow.id),
      phone: phoneOk.digits,
      email,
      salonName: salonRow.name ?? "NailIQ",
      salonAddress: salonRow.address ?? null,
    });
    if (!result.ok) {
      const status = result.error === "rate_limited"
        ? 429
        : result.error === "email_suppressed"
          ? 503
          : 500;
      return NextResponse.json({ error: result.error ?? "send_failed" }, { status });
    }
    return NextResponse.json({
      ok: true,
      deliveryAttemptId: result.deliveryAttemptId,
      deliveryStatus: result.deliveryStatus,
    });
  }

  // ── SMS channel (default) ───────────────────────────────────────────────
  const e164 = `+${phoneOk.digits}`;
  const attempt = await createBookingOtpDeliveryAttempt({
    salonId: String(salonRow.id),
    channel: "sms",
    recipient: e164,
  });
  if (!attempt.ok) {
    return NextResponse.json({ error: attempt.error }, { status: 503 });
  }
  // Show the salon's own name in the OTP message instead of the generic Verify
  // Service name, so the customer recognizes who's texting them.
  const result = await sendVerification(e164, salonRow.name ?? undefined, {
    deliveryAttemptId: attempt.attemptId,
  });

  if (result.suppressed) {
    await completeBookingOtpDeliveryAttempt({
      attemptId: attempt.attemptId,
      status: "suppressed",
      errorCode: "sms_suppressed",
    });
    return NextResponse.json({ error: "sms_suppressed" }, { status: 503 });
  }

  if (!result.ok) {
    console.error("[booking-otp/send] sendVerification failed", result.error);
    const unknown = result.error === "provider_response_unknown" ||
      result.error === "provider_response_unverified";
    await completeBookingOtpDeliveryAttempt({
      attemptId: attempt.attemptId,
      status: unknown ? "unknown" : "failed",
      providerRequestId: result.verificationSid,
      providerAttemptId: result.providerAttemptId,
      errorCode: result.error ?? "send_failed",
    });
    return NextResponse.json(
      { error: unknown ? "delivery_unknown" : result.error ?? "send_failed" },
      { status: unknown ? 503 : 500 },
    );
  }

  const finalized = await completeBookingOtpDeliveryAttempt({
    attemptId: attempt.attemptId,
    status: "provider_accepted",
    providerRequestId: result.verificationSid,
    providerAttemptId: result.providerAttemptId,
  });
  if (!finalized) {
    // The pre-send claim and Twilio Verify tags preserve correlation even if
    // this completion write is temporarily unavailable.
    console.error("[booking-otp/send] SMS accepted; completion pending reconciliation");
  }

  return NextResponse.json({
    ok: true,
    deliveryAttemptId: attempt.attemptId,
    deliveryStatus: "provider_accepted",
  });
}
