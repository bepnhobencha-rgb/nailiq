import { NextResponse } from "next/server";

import { inspectBookingManagementCapability } from "@/shared/booking/bookingManagementCapabilities";
import { consumeBookingManagementRateLimit } from "@/shared/booking/bookingManagementRateLimit";
import { loadTurnIqCustomerStatusEta } from "@/shared/turniq/customerStatusEtaLoader";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

function statusFor(code: string): number {
  if (code === "invalid_token" || code === "invalid_request") return 400;
  if (code === "expired_or_revoked" || code === "token_consumed") return 410;
  if (code === "management_unavailable" || code === "invalid_management_response") return 503;
  return 404;
}

export async function GET(request: Request): Promise<NextResponse> {
  const tokenId = new URL(request.url).searchParams.get("token")?.trim() ?? "";
  const rate = await consumeBookingManagementRateLimit({
    request,
    tokenId,
    action: "status",
    phase: "inspect",
  });
  if (rate !== "allowed") {
    return NextResponse.json({
      ok: false,
      code: rate === "limited" ? "rate_limited" : "management_unavailable",
    }, {
      status: rate === "limited" ? 429 : 503,
      headers: PRIVATE_HEADERS,
    });
  }
  const inspected = await inspectBookingManagementCapability({ tokenId, expectedAction: "status" });
  if (!inspected.ok) {
    return NextResponse.json(inspected, { status: statusFor(inspected.code), headers: PRIVATE_HEADERS });
  }
  const { booking, context } = inspected.inspection;
  const turnIqEta = context.currentStartTimeUtc && context.durationMinutes
    ? await loadTurnIqCustomerStatusEta({
        salonId: context.salonId,
        bookingId: context.bookingId,
        groupId: context.groupId,
        bookingStatus: booking.status,
        currentStartTimeUtc: context.currentStartTimeUtc,
        durationMinutes: context.durationMinutes,
      })
    : null;
  return NextResponse.json({
    ok: true,
    code: "valid",
    booking: inspected.inspection.booking,
    turnIqEta,
  }, {
    headers: PRIVATE_HEADERS,
  });
}
