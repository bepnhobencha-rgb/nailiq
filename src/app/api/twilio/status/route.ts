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
import crypto from "node:crypto";
import { updateNotificationBySid } from "@/shared/lib/notificationLog";

export const runtime = "nodejs";

/** Twilio statuses that map to our schema. */
const TERMINAL_STATUSES = new Set(["delivered", "undelivered", "failed"]);

function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
  authToken: string,
): boolean {
  // Twilio signature: HMAC-SHA1 of (url + sorted key+value pairs)
  const sortedKeys = Object.keys(params).sort();
  const data = url + sortedKeys.map((k) => k + (params[k] ?? "")).join("");
  const computed = crypto
    .createHmac("sha1", authToken)
    .update(data)
    .digest("base64");
  return crypto.timingSafeEqual(
    Buffer.from(computed),
    Buffer.from(signature),
  );
}

async function getTwilioAuthToken(): Promise<string | null> {
  try {
    const { createServiceRoleClient } = await import(
      "@/shared/lib/supabase/serviceRole"
    );
    const supabase = createServiceRoleClient();
    const { data } = await supabase
      .from("platform_settings")
      .select("twilio_auth_token")
      .eq("id", "platform")
      .maybeSingle();
    const token = (data as { twilio_auth_token?: string | null } | null)
      ?.twilio_auth_token?.trim();
    if (token) return token;
  } catch {
    // fall through
  }
  return process.env.TWILIO_AUTH_TOKEN?.trim() ?? null;
}

export async function POST(req: NextRequest) {
  const authToken = await getTwilioAuthToken();

  if (authToken) {
    const signature = req.headers.get("x-twilio-signature") ?? "";
    const url =
      (process.env.NEXT_PUBLIC_APP_URL ?? "https://nailiq.ca").replace(/\/$/, "") +
      "/api/twilio/status";

    // Parse body for signature validation
    const rawBody = await req.text();
    const params = Object.fromEntries(new URLSearchParams(rawBody).entries());

    if (signature && !validateTwilioSignature(url, params, signature, authToken)) {
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
