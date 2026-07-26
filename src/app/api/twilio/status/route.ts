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
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  getTwilioAuthToken,
  validateTwilioSignature,
  twilioRequestBaseUrl,
} from "@/shared/lib/twilioSignature";

export const runtime = "nodejs";

/** Twilio statuses that map to our schema. */
const TERMINAL_STATUSES = new Set(["delivered", "undelivered", "failed"]);

export async function POST(req: NextRequest) {
  const supabase = createServiceRoleClient();
  const authToken = await getTwilioAuthToken(supabase);

  if (authToken) {
    const signature = req.headers.get("x-twilio-signature") ?? "";
    const url = `${twilioRequestBaseUrl(req)}/api/twilio/status`;

    // Parse body for signature validation
    const rawBody = await req.text();
    const params = Object.fromEntries(new URLSearchParams(rawBody).entries());

    if (!validateTwilioSignature(url, params, signature, authToken)) {
      console.warn("[twilio/status] invalid signature");
      return new NextResponse("Forbidden", { status: 403 });
    }

    const messageSid = params.MessageSid ?? "";
    const messageStatus = (params.MessageStatus ?? "").toLowerCase();
    const errorCode = params.ErrorCode?.trim() || null;

    if (messageSid && TERMINAL_STATUSES.has(messageStatus)) {
      await updateNotificationBySid(
        messageSid,
        messageStatus as "delivered" | "undelivered" | "failed",
        errorCode,
      );
    }
  } else {
    // No auth token configured — still parse and update (dev/test mode)
    const formData = await req.formData().catch(() => null);
    if (formData) {
      const messageSid = String(formData.get("MessageSid") ?? "");
      const messageStatus = String(formData.get("MessageStatus") ?? "").toLowerCase();
      const errorCode = String(formData.get("ErrorCode") ?? "").trim() || null;
      if (messageSid && TERMINAL_STATUSES.has(messageStatus)) {
        await updateNotificationBySid(
          messageSid,
          messageStatus as "delivered" | "undelivered" | "failed",
          errorCode,
        );
      }
    }
  }

  // Twilio expects 200 + empty TwiML body
  return new NextResponse(
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    },
  );
}
