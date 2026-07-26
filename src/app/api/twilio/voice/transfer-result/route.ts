import { NextRequest, NextResponse } from "next/server";

import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import {
  getTwilioAuthToken,
  twilioRequestBaseUrl,
  validateTwilioSignature,
} from "@/shared/lib/twilioSignature";
import { buildHumanTransferResultTwiml } from "@/shared/lib/twilioCallTransfer";
import {
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "@/shared/voiceai/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function twimlResponse(xml: string): NextResponse {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?>${xml}`, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

/**
 * Twilio <Dial action> callback. A completed human conversation hangs up
 * cleanly; busy/no-answer/failed plays the short fallback. Keeping the branch
 * here avoids playing "no one answered" after a successful human transfer.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const params = Object.fromEntries(new URLSearchParams(rawBody).entries());
  const supabase = createServiceRoleClient();
  const authToken = await getTwilioAuthToken(supabase);
  if (!authToken) {
    return new NextResponse("Service unavailable", { status: 503 });
  }

  const signature = req.headers.get("x-twilio-signature") ?? "";
  const fullUrl =
    `${twilioRequestBaseUrl(req)}/api/twilio/voice/transfer-result` +
    req.nextUrl.search;
  if (!validateTwilioSignature(fullUrl, params, signature, authToken)) {
    console.warn("[twilio/voice/transfer-result] invalid signature");
    return new NextResponse("Forbidden", { status: 403 });
  }

  const requestedLanguage = (req.nextUrl.searchParams.get("language") ?? "") as SupportedLanguage;
  const language: SupportedLanguage = SUPPORTED_LANGUAGES.includes(requestedLanguage)
    ? requestedLanguage
    : "en";
  const dialCallStatus = params.DialCallStatus?.trim().toLowerCase() ?? "failed";

  return twimlResponse(buildHumanTransferResultTwiml(dialCallStatus, language));
}
