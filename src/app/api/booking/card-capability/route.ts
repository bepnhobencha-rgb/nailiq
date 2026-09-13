import { NextResponse } from "next/server";

import { exchangePublicBookingCardManagementCapability, inspectBookingManagementCapability } from "@/shared/booking/bookingManagementCapabilities";
import { parseCommittedBookingRecoveryReceipt, type CommittedBookingRecoveryReceipt } from "@/shared/booking/committedCardRecovery";
import { ensureNoShowCardRequirement } from "@/shared/noshow/ensureNoShowCardRequirement";
import { clientIp, durableRateLimitKey, isOverRateLimit } from "@/shared/lib/inAppRateLimit";
import { readJsonObjectWithLimit } from "@/shared/security/readJsonObjectWithLimit";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";
import { v1AllowsNoShowCardOnFile } from "@/shared/release/v1IntegrationScope";
import {
  recordCommittedBookingCardPending,
  resolveCommittedBookingCardContinuation,
} from "@/shared/booking/bookingCardContinuation";

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
    if (!["invalid_request", "create_binding_invalid", "exchange_expired"].includes(exchanged.code)) {
      await recordCommittedBookingCardPending({
        salonId,
        bookingId,
        createIdempotencyKey: idempotencyKey,
        pricingFingerprint,
        scope: "individual",
        stage: "capability",
        reason: "capability_unavailable",
      });
    }
    const status = exchanged.code === "invalid_request" ? 400
      : exchanged.code === "create_binding_invalid" || exchanged.code === "exchange_expired" ? 404
        : 503;
    return NextResponse.json({ ok: false, code: exchanged.code }, { status, headers: PRIVATE_HEADERS });
  }
  const continuationScope = exchanged.capability.scopeKind === "organizer_own"
    ? "group_organizer" : "individual";
  const requirement = await ensureNoShowCardRequirement(bookingId, { strict: true }).catch(() => null);
  if (!requirement) {
    await recordCommittedBookingCardPending({
      salonId,
      bookingId,
      createIdempotencyKey: idempotencyKey,
      pricingFingerprint,
      scope: continuationScope,
      stage: "assessment",
      reason: "assessment_unavailable",
    });
    return NextResponse.json({ ok: false, code: "management_unavailable" }, { status: 503, headers: PRIVATE_HEADERS });
  }
  let receipt: CommittedBookingRecoveryReceipt | null = null;
  if (!requirement.required && body?.includeReceipt === true) {
    // Read through the exchanged authority, never a public lookup by booking ID.
    const inspected = await inspectBookingManagementCapability({
      tokenId: exchanged.capability.tokenId, expectedAction: "card_manage",
    }).catch(() => null);
    if (inspected?.ok && inspected.inspection.context.bookingId.toLowerCase() === bookingId.toLowerCase() &&
        inspected.inspection.context.salonId.toLowerCase() === salonId.toLowerCase() && inspected.inspection.booking.status === "confirmed") {
      const booking = inspected.inspection.booking;
      receipt = parseCommittedBookingRecoveryReceipt({
        salonName: booking.salonName,
        startTimeUtc: booking.startTimeUtc,
        timezone: booking.salonTimezone,
        services: booking.sequenceReceipt
          ? booking.sequenceReceipt.segments.map((segment) => segment.serviceName)
          : [booking.serviceName],
      });
    }
    if (!receipt) return NextResponse.json({ ok: false, code: "management_unavailable" }, { status: 503, headers: PRIVATE_HEADERS });
  }
  if (requirement.required) {
    await recordCommittedBookingCardPending({
      salonId,
      bookingId,
      createIdempotencyKey: idempotencyKey,
      pricingFingerprint,
      scope: continuationScope,
      stage: "customer_action",
      reason: "card_required",
    });
  } else {
    await resolveCommittedBookingCardContinuation({
      salonId,
      bookingId,
      createIdempotencyKey: idempotencyKey,
      pricingFingerprint,
      scope: continuationScope,
      reason: "card_not_required",
    });
  }
  return NextResponse.json({
    ok: true,
    required: requirement.required,
    token: requirement.required ? exchanged.capability.tokenId : null,
    ...(receipt ? { receipt } : {}),
  }, { status: 200, headers: PRIVATE_HEADERS });
}
