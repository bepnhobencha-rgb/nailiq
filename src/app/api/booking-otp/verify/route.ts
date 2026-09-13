import { NextResponse } from "next/server";
import { z } from "zod";

import { readJsonObjectWithLimit } from "@/shared/security/readJsonObjectWithLimit";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { validateGuestPhone } from "@/shared/booking/validateGuestPhone";
import { checkVerification } from "@/shared/lib/twilioVerify";
import { checkEmailOtp } from "@/shared/lib/emailOtp";
import { isDemoOtpRuntime } from "@/shared/lib/demoOtpMode";
import type { BookingOtpVerifiedChannel } from "@/shared/booking/otpIdentityAssurance";
import {
  consumeDurableRateLimitBuckets,
  type DurableRateLimitResult,
} from "@/shared/security/publicServerActionRateLimit";
import { clientIp } from "@/shared/lib/inAppRateLimit";
import {
  isBookingOtpDeliveryAttemptId,
  markBookingOtpDeliveryVerified,
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

const bodySchema = z.object({
  phone: z.string().nullish(),
  shopSlug: z.string().nullish(),
  code: z.string().nullish(),
  email: z.string().nullish(),
  deliveryAttemptId: z.string().nullish(),
});

export async function POST(req: Request) {
  const ipRate = await consumeDurableRateLimitBuckets("booking-otp-verify", [
    { name: "ip-window", material: [clientIp(req)], limit: 60, windowSeconds: 900 },
  ]);
  if (ipRate !== "allowed") return rateResponse(ipRate);

  const parsed = bodySchema.safeParse(await readJsonObjectWithLimit(req, 2048));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const body = parsed.data;

  const phone = (body.phone ?? "").trim();
  const code = (body.code ?? "").replace(/\s/g, "");
  const shopSlug = (body.shopSlug ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  const deliveryAttemptId = (body.deliveryAttemptId ?? "").trim().toLowerCase();

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
    .select("id, phone_otp_enabled, email_links_enabled")
    .eq("slug", shopSlug)
    .maybeSingle();

  if (!salon || !(salon as unknown as { phone_otp_enabled: boolean }).phone_otp_enabled) {
    return NextResponse.json({ error: "otp_not_enabled" }, { status: 400 });
  }

  const salonId = String(salon.id);
  let verifiedChannel: BookingOtpVerifiedChannel = "legacy_unverified";
  let verifiedDelivery:
    | { channel: "sms" | "email"; recipient: string; attemptId: string }
    | null = null;

  if (!isDemoOtpRuntime()) {
    // Email proof is scoped to a booking tuple, not ownership of its phone.
    // Check it before contacting SMS so a hung SMS provider
    // cannot block a valid code delivered through the independent fallback.
    const e164 = `+${phoneOk.digits}`;
    let approved = false;
    let emailError: string | undefined;
    let smsError: string | undefined;

    if (email && salon.email_links_enabled !== false) {
      const em = await checkEmailOtp({ salonId, phone: phoneOk.digits, email, code })
        .catch(() => ({ ok: false, error: "server_error", deliveryAttemptId: undefined }));
      approved = em.ok;
      if (approved) verifiedChannel = "email";
      if (
        approved &&
        em.deliveryAttemptId &&
        isBookingOtpDeliveryAttemptId(em.deliveryAttemptId)
      ) {
        verifiedDelivery = {
          channel: "email",
          recipient: email,
          attemptId: em.deliveryAttemptId,
        };
      }
      if (!approved) emailError = em.error ?? "invalid_code";
    }

    // A supplied email does not mean the entered code came from email. Keep
    // SMS verification available when the email proof was not accepted.
    if (!approved) {
      const sms = await checkVerification(e164, code)
        .catch(() => ({ ok: false, error: "server_error" }));
      approved = sms.ok;
      if (approved) verifiedChannel = "sms";
      if (approved && isBookingOtpDeliveryAttemptId(deliveryAttemptId)) {
        verifiedDelivery = {
          channel: "sms",
          recipient: e164,
          attemptId: deliveryAttemptId,
        };
      }
      if (!approved) smsError = sms.error ?? "invalid_code";
    }

    if (!approved) {
      // An unavailable channel is not proof of an incorrect code. Preserve
      // infrastructure failures even when the other channel rejects normally.
      const errors = [emailError, smsError];
      const lastError = errors.find((error) => error === "server_error" || error === "server_misconfigured")
        ?? emailError ?? smsError ?? "invalid_code";
      const status = ["server_error", "server_misconfigured"].includes(lastError)
        ? 503
        : lastError === "expired_or_max_attempts" ? 410 : 400;
      return NextResponse.json({ error: lastError }, { status });
    }

    if (verifiedDelivery) {
      const recorded = await markBookingOtpDeliveryVerified({
        salonId,
        ...verifiedDelivery,
      });
      if (!recorded) {
        // The customer's successful verification remains authoritative. A
        // telemetry write must never force them to request another code.
        console.error("[booking-otp/verify] delivery verification truth not recorded");
      }
    }
  } else if (code !== "000000") {
    // Demo mode: only accept the magic test code.
    return NextResponse.json({ error: "invalid_code" }, { status: 400 });
  } else {
    verifiedChannel = "demo";
  }

  // Store a consumed-once session. The booking submission validates this row.
  const { data: session, error: insertErr } = await supabase
    .from("phone_otp_sessions")
    .insert({
      phone: phoneOk.digits,
      salon_id: salonId,
      verified_channel: verifiedChannel,
    } as never)
    .select("id")
    .single();

  if (insertErr || !session) {
    console.error("[booking-otp/verify] session insert failed");
    return NextResponse.json({ error: "session_error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, sessionId: (session as { id: string }).id });
}
