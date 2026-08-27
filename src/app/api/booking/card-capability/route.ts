import { NextResponse } from "next/server";

import { exchangePublicBookingCardManagementCapability } from "@/shared/booking/bookingManagementCapabilities";
import { ensureNoShowCardRequirement } from "@/shared/noshow/ensureNoShowCardRequirement";
import { clientIp, durableRateLimitKey, isOverRateLimit } from "@/shared/lib/inAppRateLimit";
import { readJsonObjectWithLimit } from "@/shared/security/readJsonObjectWithLimit";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";
import { v1AllowsNoShowCardOnFile } from "@/shared/release/v1IntegrationScope";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache",
  "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow",
} as const;

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return NextResponse.json({ ok: false, code: "forbidden" }, { status: 403, headers: PRIVATE_HEADERS });
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return NextResponse.json({ ok: false, code: "invalid_request" }, { status: 400, headers: PRIVATE_HEADERS });
  }
  const body = await readJsonObjectWithLimit(request, 2048);
  const salonId = typeof body?.salonId === "string" ? body.salonId.trim() : "";
  const bookingId = typeof body?.bookingId === "string" ? body.bookingId.trim() : "";
  const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  const pricingFingerprint = typeof body?.pricingFingerprint === "string" ? body.pricingFingerprint.trim() : "";
  if (!salonId || !bookingId || !idempotencyKey || !/^[0-9a-f]{64}$/.test(pricingFingerprint)) {
    return NextResponse.json({ ok: false, code: "invalid_request" }, { status: 400, headers: PRIVATE_HEADERS });
  }
  // This is a resolved "not applicable" state, not a retryable provider error.
  // Return before rate/DB/capability work so every committed V1 booking can
  // render success without creating a misleading card-management incident.
  if (!v1AllowsNoShowCardOnFile()) {
    return NextResponse.json({
      ok: true,
      required: false,
      token: null,
      cardManagementStatus: "not_applicable",
    }, { status: 200, headers: PRIVATE_HEADERS });
  }
  const limited = await isOverRateLimit(
    durableRateLimitKey("card-capability-exchange", clientIp(request), salonId),
    12,
    300,
    { failureMode: "block" },
  );
  if (limited) return NextResponse.json({ ok: false, code: "rate_limited" }, { status: 429, headers: PRIVATE_HEADERS });
  const exchanged = await exchangePublicBookingCardManagementCapability({
    salonId,
    bookingId,
    idempotencyKey,
    pricingFingerprint,
  });
  if (!exchanged.ok) {
    const status = exchanged.code === "invalid_request" ? 400
      : exchanged.code === "create_binding_invalid" || exchanged.code === "exchange_expired" ? 404
        : 503;
    return NextResponse.json({ ok: false, code: exchanged.code }, { status, headers: PRIVATE_HEADERS });
  }
  const requirement = await ensureNoShowCardRequirement(bookingId, { strict: true }).catch(() => null);
  if (!requirement) return NextResponse.json({ ok: false, code: "management_unavailable" }, { status: 503, headers: PRIVATE_HEADERS });
  return NextResponse.json({
    ok: true,
    required: requirement.required,
    token: requirement.required ? exchanged.capability.tokenId : null,
  }, { status: 200, headers: PRIVATE_HEADERS });
}
