import { after, NextResponse } from "next/server";

import {
  cancelBookingWithManagementCapability,
  inspectBookingManagementCapability,
} from "@/shared/booking/bookingManagementCapabilities";
import { consumeBookingManagementRateLimit } from "@/shared/booking/bookingManagementRateLimit";
import { reconcilePublicBookingManagementAudit } from "@/shared/dashboard/reconcilePublicBookingManagementAudit";
import { sendOwnerBookingNotification } from "@/shared/dashboard/sendOwnerBookingNotification";
import { chargeNoShowFee } from "@/shared/integrations/square/noshow";
import { deliverPromotedWaitlistOffer } from "@/shared/noshow/deliverPromotedWaitlistOffer";
import { deliverCustomerBookingTransitionEmail } from "@/shared/notifications/customerBookingTransitionEmail";
import { isSameOriginMutation } from "@/shared/security/sameOriginMutation";
import { readJsonObjectWithLimit } from "@/shared/security/readJsonObjectWithLimit";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function errorStatus(code: string): number {
  if (code === "invalid_request") return 400;
  if (code === "invalid_token") return 404;
  if (code === "expired_or_revoked" || code === "token_consumed") return 410;
  if (code === "management_unavailable" || code === "invalid_management_response") return 503;
  return 409;
}

async function rate(request: Request, tokenId: string, phase: "inspect" | "mutate") {
  const result = await consumeBookingManagementRateLimit({
    request,
    tokenId,
    action: "cancel",
    phase,
  });
  if (result === "allowed") return null;
  return json({
    ok: false,
    code: result === "limited" ? "rate_limited" : "management_unavailable",
  }, result === "limited" ? 429 : 503);
}

/** Read-only policy preview. It cannot cancel, charge, notify or consume. */
export async function GET(request: Request) {
  const tokenId = new URL(request.url).searchParams.get("token")?.trim() ?? "";
  const limited = await rate(request, tokenId, "inspect");
  if (limited) return limited;
  const inspected = await inspectBookingManagementCapability({
    tokenId,
    expectedAction: "cancel",
  });
  if (!inspected.ok) return json(inspected, errorStatus(inspected.code));
  const preview = inspected.inspection.cancelPreview;
  const isRsvpPreview = inspected.inspection.context.groupId !== null &&
    (inspected.inspection.scopeKind === "member_own" ||
      inspected.inspection.scopeKind === "organizer_own");
  return json({
    ok: true,
    startPast: preview.startPast,
    withinWindow: preview.withinWindow,
    willCharge: isRsvpPreview ? false : preview.willCharge,
    policyLockedByReschedule: preview.policyLockedByReschedule,
    feeCents: !isRsvpPreview && preview.willCharge ? preview.feeCents : 0,
    last4: !isRsvpPreview && preview.willCharge ? preview.cardLast4 : null,
    brand: !isRsvpPreview && preview.willCharge ? preview.cardBrand : null,
    currency: preview.currency,
    salonSlug: inspected.inspection.booking.salonSlug,
  });
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return json({ ok: false, code: "forbidden" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ ok: false, code: "invalid_request" }, 400);
  }
  const body = await readJsonObjectWithLimit(request, 1024);
  if (!body) return json({ ok: false, code: "invalid_request" }, 400);
  const tokenId = typeof body?.token === "string" ? body.token.trim() : "";
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  const limited = await rate(request, tokenId, "mutate");
  if (limited) return limited;

  // Re-read the authoritative preview immediately before mutation. The DB also
  // rejects appointments that have started, closing the inspect→write race.
  const inspected = await inspectBookingManagementCapability({ tokenId, expectedAction: "cancel" });
  if (!inspected.ok) {
    // A response-loss replay has a consumed token; the mutation RPC owns exact
    // replay recovery, so do not reject token_consumed here.
    if (inspected.code !== "token_consumed") return json(inspected, errorStatus(inspected.code));
  } else if (inspected.inspection.cancelPreview.startPast) {
    return json({ ok: false, code: "too_late" }, 409);
  }

  const result = await cancelBookingWithManagementCapability({ tokenId, requestId });
  if (!result.ok) return json(result, errorStatus(result.code));
  const committed = result.result;
  const isRsvpDecline = committed.groupId !== null && committed.rsvpSemantic === "decline" &&
    (committed.scopeKind === "member_own" || committed.scopeKind === "organizer_own");
  const preview = committed.cancelPreview;
  if (!preview) {
    // The booking may already be committed. Fail closed on an invalid stored
    // receipt and let the same request ID recover once the dependency is fixed.
    return json({ ok: false, code: "invalid_management_response" }, 503);
  }

  // Charge helper re-reads saved-card/consent state and is idempotent, so exact
  // response-loss replay can safely reconcile a missing post-commit charge.
  let feeCharged = false;
  let feeCents = 0;
  let feeStatus: "succeeded" | "pending_provider" | "unknown" | "definite_failure" | "not_applicable" =
    "not_applicable";
  if (!isRsvpDecline && preview.willCharge && preview.feeCents > 0) {
    try {
      const charged = await chargeNoShowFee(committed.bookingId, {
        note: "Late cancellation fee",
        amountCentsOverride: preview.feeCents,
        operationKind: "late_cancel_charge",
        occurrenceVersion: committed.transitionVersion ?? undefined,
      });
      feeStatus = charged.status;
      feeCharged = charged.status === "succeeded";
      feeCents = preview.feeCents;
    } catch (error) {
      console.error("[cancel-action] late-cancel charge failed", error);
      feeStatus = "unknown";
      feeCents = preview.feeCents;
    }
  }

  await reconcilePublicBookingManagementAudit({
    bookingId: committed.bookingId,
    salonId: committed.salonId,
    requestId,
    action: isRsvpDecline ? "rsvp_decline" : "cancel",
    payload: {
      reason: isRsvpDecline ? "rsvp_decline" : "customer_management_link",
      rsvp_semantic: isRsvpDecline ? "decline" : null,
      late: preview.withinWindow,
      policy_locked_by_reschedule: preview.policyLockedByReschedule,
      fee_decision: isRsvpDecline
        ? "rsvp_no_charge"
        : preview.willCharge ? feeStatus : "not_applicable",
      fee_cents: isRsvpDecline ? 0 : preview.feeCents,
    },
  });

  if (committed.transitionVersion !== null) {
    after(() => deliverCustomerBookingTransitionEmail({
      salonId: committed.salonId,
      bookingId: committed.bookingId,
      transitionKind: "cancel",
      expectedTransitionVersion: committed.transitionVersion!,
    }));
  }
  after(async () => {
    await sendOwnerBookingNotification({
      salonId: committed.salonId,
      bookingId: committed.bookingId,
      event: "cancel",
    });
    if (committed.promotedWaitlist) {
      await deliverPromotedWaitlistOffer({
        salonId: committed.salonId,
        offer: committed.promotedWaitlist,
      });
    }
  });

  if (feeStatus === "pending_provider" || feeStatus === "unknown") {
    return json({
      ok: false,
      code: "payment_reconciliation_required",
      bookingCommitted: true,
      feeStatus,
      feeCents,
      currency: preview.currency,
      idempotent: committed.idempotent,
    }, 503);
  }
  if (preview.willCharge && !isRsvpDecline && feeStatus === "not_applicable") {
    return json({
      ok: false,
      code: "payment_unavailable",
      bookingCommitted: true,
      feeStatus,
      feeCents,
      currency: preview.currency,
      idempotent: committed.idempotent,
    }, 503);
  }

  return json({
    ok: true,
    code: isRsvpDecline ? "declined" : committed.code,
    salonSlug: committed.salonSlug,
    booking: {
      status: committed.status,
      startTimeUtc: committed.startTimeUtc,
      endTimeUtc: committed.endTimeUtc,
      serviceName: committed.serviceName,
      staffName: committed.staffName,
      salonSlug: committed.salonSlug,
      salonName: committed.salonName,
      salonTimezone: committed.salonTimezone,
    },
    feeCharged,
    feeStatus,
    feeCents,
    currency: preview.currency,
    rsvpSemantic: committed.rsvpSemantic,
    attendanceStatus: committed.attendanceStatus,
    idempotent: committed.idempotent,
  });
}
