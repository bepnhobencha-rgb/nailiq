import { NextResponse, type NextRequest } from "next/server";
import { clientIp } from "@/shared/lib/inAppRateLimit";
import {
  groupBookingCreateRequestSchema,
  groupBookingRateKey,
  authorizeGroupBookingBoundary,
  createGroupBookingsAuthoritative,
} from "@/shared/booking/groupBookingPricingServer";
import {
  groupBookingRateLimitAllowed,
  isAllowedGroupBookingOrigin,
} from "@/shared/booking/groupBookingApiBoundary";
import { serializeGroupBookingPricingQuote } from "@/shared/booking/groupBookingPricing";
import { ensureNoShowCardRequirement } from "@/shared/noshow/ensureNoShowCardRequirement";
import { mintBookingManagementCapability } from "@/shared/booking/bookingManagementCapabilities";
import { saveCardWithManagementCapability } from "@/shared/booking/bookingCardManagement";

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
    20,
    300,
  );
  if (ipAllowed == null) return json({ ok: false, code: "create_unavailable" }, 503);
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
  const parsed = groupBookingCreateRequestSchema.safeParse(body);
  if (!parsed.success) return json({ ok: false, code: "invalid_request" }, 400);
  const organizerPhone = parsed.data.bookings[0].clientPhone!;
  const phoneAllowed = await groupBookingRateLimitAllowed(
    groupBookingRateKey("phone", `${parsed.data.salonId}:${organizerPhone}`),
    10,
    300,
  );
  if (phoneAllowed == null) return json({ ok: false, code: "create_unavailable" }, 503);
  if (!phoneAllowed) return json({ ok: false, code: "rate_limited" }, 429, "300");

  const authorization = await authorizeGroupBookingBoundary({
    salonId: parsed.data.salonId,
    organizerPhone,
    otpSessionId: parsed.data.otpSessionId,
    requireOtp: true,
  });
  if (!authorization.ok) {
    const code = authorization.code === "booking_unavailable"
      ? "create_unavailable"
      : authorization.code;
    return json({ ok: false, code }, code === "otp_required" || code === "otp_invalid" ? 403 : 503);
  }

  const result = await createGroupBookingsAuthoritative(parsed.data);
  let cardManagementToken: string | null = null;
  let cardManagementPending = false;
  if (result.ok && result.bookingIds[0]) {
    try {
      const requirement = await ensureNoShowCardRequirement(result.bookingIds[0], { strict: true });
      if (requirement.required) {
        const capability = await mintBookingManagementCapability({
          salonId: parsed.data.salonId,
          bookingId: result.bookingIds[0],
          action: "card_manage",
          minExpiresAt: new Date(Date.now() + 25 * 60_000).toISOString(),
        });
        if (capability.ok) cardManagementToken = capability.capability.tokenId;
        else cardManagementPending = true;
      }
    } catch {
      // Booking is already committed. Missing card capability is surfaced as
      // null so the UI never falls back to naked booking-id authorization.
      cardManagementToken = null;
      cardManagementPending = true;
    }
  }
  if (result.ok && !cardManagementPending && cardManagementToken && parsed.data.cardSourceId) {
    if (parsed.data.noShowConsent !== true) {
      cardManagementToken = null;
      cardManagementPending = true;
    } else {
      const saved = await saveCardWithManagementCapability({
        tokenId: cardManagementToken,
        requestId: parsed.data.idempotencyKey,
        provider: "square",
        sourceToken: parsed.data.cardSourceId,
        verificationToken: parsed.data.cardVerificationToken,
      });
      if (!saved.ok) {
        cardManagementToken = null;
        cardManagementPending = true;
      } else {
        cardManagementToken = null;
      }
    }
  }
  const status = result.ok
    ? 200
    : result.code === "invalid_request"
      ? 400
      : result.code === "voucher_invalid" || result.code === "pricing_changed"
        ? 409
        : result.code === "idempotency_conflict" ||
            result.code === "slot_conflict" ||
            result.code === "monthly_booking_limit_reached"
          ? 409
          : 503;
  const bodyResult = result.ok
    ? {
        ok: true,
        groupId: result.groupId,
        bookingIds: result.bookingIds,
        idempotent: result.idempotent,
        cardManagementToken,
        // Booking creation is the authoritative outcome. Card management is a
        // post-commit recovery concern: the booking row is already flagged by
        // ensureNoShowCardRequirement, so reporting a false create failure here
        // would invite the customer to submit the same party again.
        cardManagementPending,
        pricing: serializeGroupBookingPricingQuote(result.pricing),
      }
    : result.code === "pricing_changed" && result.quote
      ? {
          ok: false,
          code: "pricing_changed",
          quote: serializeGroupBookingPricingQuote(result.quote),
        }
      : result;
  return json(bodyResult, status);
}
