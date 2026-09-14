import "server-only";

import { after, NextResponse } from "next/server";

import { saveCardWithManagementCapability } from "@/shared/booking/bookingCardManagement";
import { consumeBookingManagementRateLimit } from "@/shared/booking/bookingManagementRateLimit";

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

export async function handleBookingCardCapability(request: Request) {
  request.signal.throwIfAborted();
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
  request.signal.throwIfAborted();
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
  request.signal.throwIfAborted();
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

const json = (body: Record<string, unknown>, status = 200) =>
  NextResponse.json(body, { status, headers: PRIVATE_HEADERS });

/** Saves a provider token under a durable card_manage operation. No charge. */
export async function handleBookingCardSave(request: Request) {
  request.signal.throwIfAborted();
  if (!isSameOriginMutation(request)) return json({ ok: false, code: "forbidden" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ ok: false, code: "invalid_request" }, 400);
  }
  const body = await readJsonObjectWithLimit(request, 4096);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  const sourceId = typeof body?.sourceId === "string" ? body.sourceId.trim() : "";
  const provider = body?.provider === "square" || body?.provider === "stripe" ? body.provider : null;
  const verificationToken = typeof body?.verificationToken === "string"
    ? body.verificationToken.trim()
    : undefined;
  if (!token || !requestId || !sourceId || !provider || body?.consent !== true) {
    return json({ ok: false, code: "invalid_request" }, 400);
  }
  // A stale capability must not claim an operation while the narrow card-on-file
  // gate is disabled. Keep this ahead of rate-limit/database/provider work.
  if (!v1AllowsNoShowCardOnFile()) {
    return json({ ok: false, code: "phase_2_not_available" }, 503);
  }
  const rate = await consumeBookingManagementRateLimit({
    request, tokenId: token, action: "card_manage", phase: "mutate",
  });
  if (rate !== "allowed") {
    return json({ ok: false, code: rate === "limited" ? "rate_limited" : "management_unavailable" }, rate === "limited" ? 429 : 503);
  }
  // Do not enter the durable save service if the limiter consumed the deadline.
  // Once entered, that service may finish after the caller returns pending;
  // its operation receipt/reconciliation owns that unknown outcome, not replay.
  request.signal.throwIfAborted();
  const result = await saveCardWithManagementCapability({
    tokenId: token,
    requestId,
    provider,
    sourceToken: sourceId,
    verificationToken,
  });
  const status = result.ok ? 200
    : result.code === "save_failed" && result.failureKind === "card_rejected" ? 422
    : result.code === "invalid_request" ? 400
      : result.code === "invalid_token" || result.code === "expired_or_revoked" ? 404
        : result.code === "idempotency_mismatch" || result.code === "in_flight" || result.code === "operation_conflict" ? 409
          : 503;
  return json(result as unknown as Record<string, unknown>, status);
}

/**
 * Server-only post-commit transport. Reuse the public handlers in-process so
 * deployment SSO cannot turn an authoritative no-card receipt into recovery.
 * The handlers still validate exact create/capability authority and rate limits.
 * No cookies, authorization, deployment credentials or arbitrary URLs cross it.
 */
export function createCommittedBookingCardServerTransport(request: Request) {
  const requestOrigin = new URL(request.url).origin;
  const callerIp = clientIp(request);
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const handler = input === "/api/booking/card-capability"
      ? handleBookingCardCapability
      : input === "/api/booking/square-save-card" ? handleBookingCardSave : null;
    if (!handler || init?.method !== "POST" || typeof init.body !== "string") {
      throw new Error("invalid_card_management_transport");
    }
    init.signal?.throwIfAborted();
    const headers = new Headers({
      "Content-Type": new Headers(init.headers).get("content-type") ?? "",
      Origin: requestOrigin,
      "x-forwarded-for": callerIp,
    });
    const internalRequest = new Request(new URL(String(input), requestOrigin), {
      method: "POST", headers, body: init.body, signal: init.signal,
    });
    let finish!: () => void;
    const completion = new Promise<void>((resolve) => { finish = resolve; });
    // Register before starting durable work. If the UI deadline wins, Next's
    // waitUntil keeps this same operation alive up to the platform duration.
    // The callback only waits; it never repeats the handler or logs its error.
    after(() => completion);
    try {
      return await handler(internalRequest);
    } finally {
      finish();
    }
  };
}
