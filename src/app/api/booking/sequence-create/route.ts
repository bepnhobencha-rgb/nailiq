import { after, NextResponse, type NextRequest } from "next/server";

import {
  bookingSequenceRateKey,
  createPublicBookingSequence,
  replayPublicBookingSequence,
  type BookingSequenceCreateResult,
} from "@/shared/booking/bookingSequenceServer";
import {
  parseSequenceBookingIntent,
  type SequenceBookingIntent,
} from "@/shared/booking/bookingSequence";
import { loadPublicBookingSequenceReadiness } from "@/shared/booking/bookingSequenceReadiness";
import { sendBookingConfirmationEmail } from "@/shared/booking/sendBookingConfirmationEmail";
import { clientIp } from "@/shared/lib/inAppRateLimit";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { readJsonObjectWithLimit } from "@/shared/security/readJsonObjectWithLimit";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store" } as const;
const SHA256_RE = /^[0-9a-f]{64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body: unknown, status: number, retryAfter?: string) {
  return NextResponse.json(body, {
    status,
    headers: { ...HEADERS, ...(retryAfter ? { "Retry-After": retryAfter } : {}) },
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function rateLimitAllowed(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean | null> {
  try {
    const { data, error } = await createServiceRoleClient().rpc(
      "rate_limit_hit" as never,
      { p_key: key, p_limit: limit, p_window_seconds: windowSeconds } as never,
    );
    return error || typeof data !== "boolean" ? null : data;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  if (!isSameOriginMutation(request)) {
    return json({ ok: false, code: "forbidden" }, 403);
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return json({ ok: false, code: "invalid_request" }, 400);
  }
  const body = await readJsonObjectWithLimit(request, 20_480);
  const raw = record(body);
  if (
    !raw ||
    Object.keys(raw).some(
      (key) => ![
        "intent",
        "expectedPricingFingerprint",
        "otpSessionId",
        "healthAcknowledged",
        "smsConsent",
        "language",
      ].includes(key),
    )
  ) {
    return json({ ok: false, code: "invalid_request" }, 400);
  }

  const intent = parseSequenceBookingIntent(raw.intent);
  const expectedPricingFingerprint =
    typeof raw.expectedPricingFingerprint === "string"
      ? raw.expectedPricingFingerprint.trim()
      : "";
  const otpSessionId = raw.otpSessionId == null
    ? null
    : typeof raw.otpSessionId === "string"
      ? raw.otpSessionId.trim()
      : "";
  const healthAcknowledged = raw.healthAcknowledged;
  const smsConsent = raw.smsConsent;
  const language = raw.language;
  if (
    !intent ||
    !SHA256_RE.test(expectedPricingFingerprint) ||
    otpSessionId === "" ||
    (otpSessionId != null && !UUID_RE.test(otpSessionId)) ||
    typeof healthAcknowledged !== "boolean" ||
    typeof smsConsent !== "boolean" ||
    (language !== "en" && language !== "vi")
  ) {
    return json({ ok: false, code: "invalid_request" }, 400);
  }

  const createArgs = {
    intent,
    expectedPricingFingerprint,
    otpSessionId,
    healthAcknowledged,
    smsConsent,
    language,
  } as const;
  // Response-loss recovery must precede every mutable rate, rollout,
  // readiness and OTP preflight. The read-only DB seam waits for an in-flight
  // create and binds the full canonical request (including consent/locale).
  const replay = await replayPublicBookingSequence(createArgs);
  if (replay.ok) return finishSequenceCreate(replay, intent);
  if (replay.code !== "replay_not_found") {
    return sequenceCreateFailure(replay);
  }

  const ipRateAllowed = await rateLimitAllowed(
    bookingSequenceRateKey("ip", clientIp(request)),
    12,
    300,
  );
  if (ipRateAllowed == null) return json({ ok: false, code: "create_unavailable" }, 503);
  if (!ipRateAllowed) return json({ ok: false, code: "rate_limited" }, 429, "300");

  const phoneRateAllowed = await rateLimitAllowed(
    bookingSequenceRateKey("phone", `${intent.salonId}:${intent.customer.phone}`),
    6,
    300,
  );
  if (phoneRateAllowed == null) return json({ ok: false, code: "create_unavailable" }, 503);
  if (!phoneRateAllowed) return json({ ok: false, code: "rate_limited" }, 429, "300");

  const readiness = await loadPublicBookingSequenceReadiness(intent.salonId);
  if (!readiness.ok) return json({ ok: false, code: "booking_unavailable" }, 503);

  const otpAuthorization = await authorizeSequenceOtp({
    salonId: intent.salonId,
    otpSessionId,
  });
  if (otpAuthorization !== "allowed") {
    return json(
      { ok: false, code: otpAuthorization === "otp_required" ? "otp_required" : "create_unavailable" },
      otpAuthorization === "otp_required" ? 403 : 503,
    );
  }

  const result = await createPublicBookingSequence(createArgs);
  if (result.ok) return finishSequenceCreate(result, intent);
  return sequenceCreateFailure(result);
}

function finishSequenceCreate(
  result: Extract<BookingSequenceCreateResult, { ok: true }>,
  intent: SequenceBookingIntent,
) {
  after(async () => {
    try {
      const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").trim() || "https://nailiq.ca";
      await fetch(`${appUrl}/api/booking/sms-confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bookingId: result.bookingId,
          salonId: intent.salonId,
          language: result.language,
          smsConsent: result.smsConsent,
        }),
      });
    } catch (error) {
      console.error("[sequence-create] sms confirmation dispatch failed", error);
    }
  });
  if (intent.customer.email) {
    after(() =>
      sendBookingConfirmationEmail({
        bookingId: result.bookingId,
        shopSlug: result.salonSlug,
        clientName: intent.customer.name,
        clientEmail: intent.customer.email!,
        serviceName: result.quote.lines.map((line) => line.serviceName).join(" + "),
        staffName: [...new Set(result.quote.lines.map((line) => line.staffName))].join(", "),
        startTimeUtc: result.quote.parentStartTimeUtc,
        totalPriceCents: result.quote.totalCents,
        subtotalCents: result.quote.subtotalCents,
        taxBreakdown: result.quote.taxBreakdown,
        currencyCode: result.quote.currency,
      }),
    );
  }
  return json(result, 200);
}

function sequenceCreateFailure(
  result: Extract<BookingSequenceCreateResult, { ok: false }>,
) {
  const status = result.code === "invalid_request"
    ? 400
    : result.code === "otp_required" ||
        result.code === "invalid_otp_session" ||
        result.code === "otp_session_used" ||
        result.code === "otp_not_required"
      ? 403
      : result.code === "health_ack_required" || result.code === "payment_not_supported"
        ? 422
    : result.code === "pricing_changed" ||
        result.code === "idempotency_conflict" ||
        result.code === "booking_state_changed" ||
        result.code === "slot_conflict" ||
        result.code === "monthly_booking_limit_reached"
      ? 409
      : 503;
  return json(result, status);
}

async function authorizeSequenceOtp(args: {
  salonId: string;
  otpSessionId: string | null;
}): Promise<"allowed" | "otp_required" | "unavailable"> {
  try {
    const db = createServiceRoleClient();
    const { data: salon, error } = await db
      .from("salons" as never)
      .select("phone_otp_enabled" as never)
      .eq("id" as never, args.salonId)
      .maybeSingle();
    if (error || !salon) return "unavailable";
    if ((salon as { phone_otp_enabled?: unknown }).phone_otp_enabled !== true) {
      return "allowed";
    }
    if (!args.otpSessionId || !UUID_RE.test(args.otpSessionId)) return "otp_required";
    // The RPC owns mutable session validation and consumption. In particular,
    // it checks an exact committed replay before rejecting a consumed session.
    // A stateful route preflight would strand response-loss retries.
    return "allowed";
  } catch {
    return "unavailable";
  }
}
