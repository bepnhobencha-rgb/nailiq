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
  if (ipAllowed == null) return json({ ok: false, code: "quote_unavailable" }, 503);
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
  if (phoneAllowed == null) return json({ ok: false, code: "quote_unavailable" }, 503);
  if (!phoneAllowed) return json({ ok: false, code: "rate_limited" }, 429, "300");

  const authorization = await authorizeGroupBookingBoundary({
    salonId: parsed.data.salonId,
    organizerPhone,
    requireOtp: false,
  });
  if (!authorization.ok) return json({ ok: false, code: "booking_unavailable" }, 503);

  const result = await resolveGroupBookingQuote(parsed.data);
  const status = result.ok
    ? 200
    : result.code === "invalid_request"
      ? 400
      : result.code === "voucher_invalid"
        ? 422
        : 503;
  return json(
    result.ok
      ? { ok: true, quote: serializeGroupBookingPricingQuote(result.quote) }
      : result,
    status,
  );
}
