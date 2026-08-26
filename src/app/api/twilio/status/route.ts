/**
 * POST /api/twilio/status
 * Twilio StatusCallback webhook — receives delivery receipts for outbound SMS.
 * Twilio POSTs application/x-www-form-urlencoded with MessageSid + MessageStatus.
 *
 * Configure in Twilio console (or via StatusCallback param in each message):
 *   https://nailiq.ca/api/twilio/status
 *
 * Validated using X-Twilio-Signature HMAC-SHA1.
 */

import { NextRequest, NextResponse } from "next/server";
import { updateNotificationBySid } from "@/shared/lib/notificationLog";
import {
  getTwilioAuthToken,
  validateTwilioSignature,
  twilioRequestBaseUrl,
} from "@/shared/lib/twilioSignature";
import { readUrlEncodedFormWithLimit } from "@/shared/security/readUrlEncodedFormWithLimit";

export const runtime = "nodejs";

/** Twilio statuses that map to our schema. */
const TERMINAL_STATUSES = new Set(["delivered", "undelivered", "failed"]);
const KNOWN_MESSAGE_STATUSES = new Set([
  "accepted",
  "scheduled",
  "queued",
  "sending",
  "sent",
  "delivered",
  "undelivered",
  "failed",
  "receiving",
  "received",
  "read",
  "canceled",
]);
const MESSAGE_SID_RE = /^(?:SM|MM)[0-9a-f]{32}$/iu;
const ERROR_CODE_RE = /^[0-9]{3,8}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function twiml(): NextResponse {
  return new NextResponse(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    { status: 200, headers: { "Content-Type": "text/xml" } },
  );
}

export async function POST(req: NextRequest) {
  const form = await readUrlEncodedFormWithLimit(req, 8_192);
  if (!form) return new NextResponse("Invalid request", { status: 400 });
  const params = Object.fromEntries(form.entries());

  const { createServiceRoleClient } = await import("@/shared/lib/supabase/serviceRole");
  const supabase = createServiceRoleClient();
  const authToken = await getTwilioAuthToken(supabase);
  if (!authToken) {
    console.error("[twilio/status] auth token unavailable");
    return new NextResponse("Service unavailable", { status: 503 });
  }

  const signature = req.headers.get("x-twilio-signature") ?? "";
  // Twilio signs the full callback URL, including the review-notification
  // correlation query parameter when present.
  const url = `${twilioRequestBaseUrl(req)}${req.nextUrl.pathname}${req.nextUrl.search}`;

  if (!validateTwilioSignature(url, params, signature, authToken)) {
    console.warn("[twilio/status] invalid signature");
    return new NextResponse("Forbidden", { status: 403 });
  }

  const messageSid = params.MessageSid?.trim() ?? "";
  const messageStatus = params.MessageStatus?.trim().toLowerCase() ?? "";
  const errorCode = params.ErrorCode?.trim() || null;
  const notificationIdRaw = req.nextUrl.searchParams.get("notification_id");
  const notificationId = notificationIdRaw?.trim() || undefined;

  if (
    !MESSAGE_SID_RE.test(messageSid) ||
    !KNOWN_MESSAGE_STATUSES.has(messageStatus) ||
    (notificationId !== undefined && !UUID_RE.test(notificationId))
  ) {
    return new NextResponse("Invalid receipt", { status: 422 });
  }
  // Twilio can report authenticated lifecycle states before (and, for some
  // channels, after) the terminal SMS states stored by NailIQ. Preserve the
  // prior 200/no-write behavior for those recognized receipts.
  if (!TERMINAL_STATUSES.has(messageStatus)) return twiml();
  if (
    (errorCode !== null && !ERROR_CODE_RE.test(errorCode)) ||
    (messageStatus === "delivered" && errorCode !== null)
  ) {
    return new NextResponse("Invalid receipt", { status: 422 });
  }
  const updated = notificationId
    ? await updateNotificationBySid(
        messageSid,
        messageStatus as "delivered" | "undelivered" | "failed",
        errorCode,
        notificationId,
      )
    : await updateNotificationBySid(
        messageSid,
        messageStatus as "delivered" | "undelivered" | "failed",
        errorCode,
      );
  // Never report success for a terminal receipt that was not durably attached
  // to its unique outbound notification/claim. Provider retry behavior is a
  // separate deployed acceptance gate and is not assumed here.
  if (!updated.ok) {
    if (updated.code === "invalid_receipt") {
      return new NextResponse("Invalid receipt", { status: 422 });
    }
    if (updated.code === "terminal_conflict") {
      return new NextResponse("Receipt conflict", { status: 409 });
    }
    return new NextResponse("Service unavailable", { status: 503 });
  }

  return twiml();
}
