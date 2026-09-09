import { NextResponse, type NextRequest } from "next/server";
import { clientIp } from "@/shared/lib/inAppRateLimit";
import {
  groupBookingQuoteRequestSchema,
  groupBookingRateKey,
  authorizeGroupBookingBoundary,
  resolveGroupBookingQuote,
} from "@/shared/booking/groupBookingPricingServer";
import {
  groupBookingRateLimitAllowed,
  isAllowedGroupBookingOrigin,
} from "@/shared/booking/groupBookingApiBoundary";
import { serializeGroupBookingPricingQuote } from "@/shared/booking/groupBookingPricing";

export const dynamic = "force-dynamic";

function json(body: unknown, status: number, retryAfter?: string) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(retryAfter ? { "Retry-After": retryAfter } : {}),
    },
  });
}

function logUnavailable(
  stage: "ip_metering" | "phone_metering" | "authorization" | "quote_resolution",
  code: unknown,
) {
  // Only fixed vocabulary reaches the runtime log; never accept the request,
  // tenant identifiers, metering keys, or raw dependency errors here.
  const outcome = code === "quote_unavailable" || code === "booking_unavailable" ||
    code === "slot_conflict" || code === "pricing_invalid"
    ? code
    : "unrecognized_failure";
  try {
    console.warn(JSON.stringify({
      event: "group_quote_unavailable",
      status: 503,
      stage,
      outcome,
    }));
  } catch {
    // Diagnostics must not change the booking response if the log sink fails.
  }
}

export async function POST(request: NextRequest) {
  if (!isAllowedGroupBookingOrigin(request)) {
    return json({ ok: false, code: "forbidden" }, 403);
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > 65_536) {
    return json({ ok: false, code: "invalid_request" }, 400);
  }
  const ipAllowed = await groupBookingRateLimitAllowed(
    groupBookingRateKey("ip", clientIp(request)),
    30,
    300,
  );
  if (ipAllowed == null) {
    logUnavailable("ip_metering", "quote_unavailable");
    return json({ ok: false, code: "quote_unavailable" }, 503);
  }
  if (!ipAllowed) return json({ ok: false, code: "rate_limited" }, 429, "300");

  const bodyText = await request.text().catch(() => "");
  if (!bodyText || new TextEncoder().encode(bodyText).byteLength > 65_536) {
    return json({ ok: false, code: "invalid_request" }, 400);
  }
  const body = (() => {
    try {
      return JSON.parse(bodyText) as unknown;
    } catch {
      return null;
    }
  })();
  const parsed = groupBookingQuoteRequestSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, code: "invalid_request" }, 400);
  const organizerPhone = parsed.data.bookings[0].clientPhone!;
  const phoneAllowed = await groupBookingRateLimitAllowed(
    groupBookingRateKey("phone", `${parsed.data.salonId}:${organizerPhone}`),
    15,
    300,
  );
  if (phoneAllowed == null) {
    logUnavailable("phone_metering", "quote_unavailable");
    return json({ ok: false, code: "quote_unavailable" }, 503);
  }
  if (!phoneAllowed) return json({ ok: false, code: "rate_limited" }, 429, "300");

  const authorization = await authorizeGroupBookingBoundary({
    salonId: parsed.data.salonId,
    organizerPhone,
    requireOtp: false,
  });
  if (!authorization.ok) {
    logUnavailable("authorization", "booking_unavailable");
    return json({ ok: false, code: "booking_unavailable" }, 503);
  }

  const result = await resolveGroupBookingQuote(parsed.data);
  const status = result.ok
    ? 200
    : result.code === "invalid_request"
      ? 400
      : result.code === "voucher_invalid"
        ? 422
        : 503;
  if (!result.ok && status === 503) {
    logUnavailable("quote_resolution", result.code);
  }
  return json(
    result.ok
      ? { ok: true, quote: serializeGroupBookingPricingQuote(result.quote) }
      : result,
    status,
  );
}
