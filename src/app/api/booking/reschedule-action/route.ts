import { after, NextResponse } from "next/server";

import {
  inspectBookingManagementCapability,
  rescheduleBookingWithManagementCapability,
} from "@/shared/booking/bookingManagementCapabilities";
import {
  quoteBookingSequenceReschedule,
  rescheduleBookingSequenceWithManagementCapability,
} from "@/shared/booking/bookingSequenceReschedule";
import { consumeBookingManagementRateLimit } from "@/shared/booking/bookingManagementRateLimit";
import { dayKeyFromLocalDate } from "@/shared/booking/dayKeyFromDate";
import { hmToMinutes } from "@/shared/booking/hmToMinutes";
import { parseTimeSlotToMinutes } from "@/shared/booking/parseBookingTimeSlot";
import { parseBookingClosedDateSet } from "@/shared/booking/parseBookingClosedDates";
import { reconcilePublicBookingManagementAudit } from "@/shared/dashboard/reconcilePublicBookingManagementAudit";
import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";
import { sendOwnerBookingNotification } from "@/shared/dashboard/sendOwnerBookingNotification";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { salonWallTimeToUtcIso } from "@/shared/lib/salonTime";
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

type Body = {
  token?: unknown;
  requestId?: unknown;
  date?: unknown;
  slotLabel?: unknown;
  newStartUtc?: unknown;
  newEndUtc?: unknown;
  expectedSequenceFingerprint?: unknown;
};

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function errorStatus(code: string): number {
  if (code === "invalid_request" || code === "invalid_slot") return 400;
  if (code === "invalid_token") return 404;
  if (code === "expired_or_revoked" || code === "token_consumed") return 410;
  if (code === "management_unavailable" || code === "invalid_management_response") return 503;
  return 409;
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return json({ ok: false, code: "forbidden" }, 403);
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return json({ ok: false, code: "invalid_request" }, 400);
  }
  const body = await readJsonObjectWithLimit(request, 2048) as Body | null;
  if (!body) return json({ ok: false, code: "invalid_request" }, 400);
  const tokenId = typeof body?.token === "string" ? body.token.trim() : "";
  const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
  const date = typeof body?.date === "string" ? body.date.trim() : "";
  const slotLabel = typeof body?.slotLabel === "string" ? body.slotLabel.trim() : "";
  const newStartUtc = typeof body?.newStartUtc === "string" ? body.newStartUtc.trim() : "";
  const newEndUtc = typeof body?.newEndUtc === "string" ? body.newEndUtc.trim() : "";
  const expectedSequenceFingerprint = typeof body?.expectedSequenceFingerprint === "string"
    ? body.expectedSequenceFingerprint.trim()
    : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !slotLabel ||
      !Number.isFinite(Date.parse(newStartUtc)) || !Number.isFinite(Date.parse(newEndUtc))) {
    return json({ ok: false, code: "invalid_request" }, 400);
  }

  const rate = await consumeBookingManagementRateLimit({
    request,
    tokenId,
    action: "reschedule",
    phase: "mutate",
  });
  if (rate !== "allowed") {
    return json({ ok: false, code: rate === "limited" ? "rate_limited" : "management_unavailable" }, rate === "limited" ? 429 : 503);
  }

  const inspected = await inspectBookingManagementCapability({
    tokenId,
    expectedAction: "reschedule",
  });
  let inspectedSequence = false;
  if (inspected.ok) {
    inspectedSequence = inspected.inspection.booking.scheduleModel === "segments_v1";
    const context = inspected.inspection.context;
    const db = createServiceRoleClient();
    const { data: salon } = await db
      .from("salons" as never)
      .select("opening_hours, booking_closed_dates")
      .eq("id", context.salonId)
      .maybeSingle();
    const salonRow = salon as { opening_hours?: unknown; booking_closed_dates?: unknown } | null;
    const week = parseOpeningHours(salonRow?.opening_hours);
    const closed = parseBookingClosedDateSet(salonRow?.booking_closed_dates);
    let startMinutes: number;
    try {
      startMinutes = parseTimeSlotToMinutes(slotLabel);
    } catch {
      return json({ ok: false, code: "invalid_slot" }, 400);
    }
    const day = week?.[dayKeyFromLocalDate(new Date(`${date}T12:00:00`))];
    let canonicalStart: string;
    try {
      canonicalStart = salonWallTimeToUtcIso(date, startMinutes, context.timezone);
    } catch {
      // A spring-forward wall minute does not exist. Treat it like any other
      // invalid slot; never normalize it to a different customer-visible time.
      return json({ ok: false, code: "invalid_slot" }, 400);
    }
    const canonicalEnd = new Date(Date.parse(canonicalStart) + context.durationMinutes * 60_000).toISOString();
    if (!week || !day || day.closed || closed.has(date) ||
        startMinutes < hmToMinutes(day.open) || startMinutes + context.durationMinutes > hmToMinutes(day.close) ||
        canonicalStart !== newStartUtc || canonicalEnd !== newEndUtc) {
      return json({ ok: false, code: "invalid_slot" }, 400);
    }
  } else if (inspected.code !== "token_consumed") {
    return json(inspected, errorStatus(inspected.code));
  }

  if (inspected.ok && inspectedSequence && !expectedSequenceFingerprint) {
    const quoted = await quoteBookingSequenceReschedule({
      tokenId,
      requestId,
      newStartTimeUtc: newStartUtc,
    });
    if (!quoted.ok) return json(quoted, errorStatus(quoted.code));
    return json({
      ok: true,
      code: "sequence_review_required",
      sequenceQuote: quoted.quote,
    });
  }

  // On exact response-loss replay the consumed token cannot be inspected, but
  // the browser resends the server-issued UTC slot and same request ID. The DB
  // compares its stored canonical payload before returning the prior result.
  const sequenceMutation = inspectedSequence || Boolean(expectedSequenceFingerprint);
  const result = sequenceMutation
    ? await rescheduleBookingSequenceWithManagementCapability({
        tokenId,
        requestId,
        newStartTimeUtc: newStartUtc,
        expectedSequenceFingerprint,
      })
    : await rescheduleBookingWithManagementCapability({
        tokenId,
        requestId,
        newStartTimeUtc: newStartUtc,
        newEndTimeUtc: newEndUtc,
      });
  if (!result.ok) return json(result, errorStatus(result.code));
  const committed = result.result;
  let sequenceReceipt = null;
  let responseCode: string;
  let responseServiceName: string | null;
  if ("receipt" in committed) {
    sequenceReceipt = committed.receipt;
    responseCode = "rescheduled";
    responseServiceName = committed.receipt.segments
      .map((segment) => segment.serviceName)
      .join(" + ");
  } else {
    responseCode = committed.code;
    responseServiceName = committed.serviceName;
  }

  const policyLocked = committed.cancelPreview!.policyLockedByReschedule;
  await reconcilePublicBookingManagementAudit({
    bookingId: committed.bookingId,
    salonId: committed.salonId,
    requestId,
    action: "reschedule",
    payload: {
      reason: "customer_management_link",
      previous_start_utc: committed.previousStartTimeUtc,
      new_start_utc: committed.startTimeUtc,
      late_cancel_policy_locked: policyLocked,
    },
  });

  if (committed.transitionVersion !== null) {
    after(() => deliverCustomerBookingTransitionEmail({
      salonId: committed.salonId,
      bookingId: committed.bookingId,
      transitionKind: "reschedule",
      expectedTransitionVersion: committed.transitionVersion!,
    }));
  }
  after(async () => {
    await sendOwnerBookingNotification({
      salonId: committed.salonId,
      bookingId: committed.bookingId,
      event: "reschedule",
      previousStartUtc: committed.previousStartTimeUtc,
      changedBy: "customer",
      changedFields: ["time"],
    });
    if (committed.promotedWaitlist) {
      await deliverPromotedWaitlistOffer({
        salonId: committed.salonId,
        offer: committed.promotedWaitlist,
      });
    }
  });

  return json({
    ok: true,
    code: responseCode,
    serviceName: responseServiceName,
    newStartUtc: committed.startTimeUtc,
    ...(sequenceReceipt ? { sequenceReceipt } : {}),
    lateCancelPolicyLocked: policyLocked,
    idempotent: committed.idempotent,
  });
}
