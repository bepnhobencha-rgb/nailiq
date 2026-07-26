/**
 * GET/POST /api/twilio/voice
 * Twilio Voice inbound-call webhook. Configure a salon's Twilio number Voice URL:
 *   https://nailiq.ca/api/twilio/voice?slug=<salon-slug>
 *
 * Twilio numbers request the Voice URL with EITHER method depending on the
 * number's (often region-specific) config — some default to GET — so we accept
 * both. On GET all params ride the query string and Twilio signs the full URL
 * with no appended params; on POST the params are in the body and are appended
 * to the signed URL. Getting this wrong 405s or 403s every real call.
 *
 * Returns TwiML that bridges the live call audio to the AI receptionist voice
 * bridge over a WebSocket (<Connect><Stream>). The caller's carrier-verified
 * number (`From`) is passed to the bridge as a Stream <Parameter>, so it can be
 * forwarded to /api/voice/tool as callerVerifiedPhone — enabling the Module 1
 * caller-ID identity tier for that call.
 *
 * Signature-validated (X-Twilio-Signature), mirroring /api/twilio/inbound.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { getTwilioAuthToken, validateTwilioSignature, twilioRequestBaseUrl } from "@/shared/lib/twilioSignature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function twimlResponse(xml: string): NextResponse {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?>${xml}`, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c,
  );
}

// Twilio may call the Voice URL with GET (params in the query, nothing appended
// to the signed URL) or POST (params in the body, appended to the signed URL).
export async function GET(req: NextRequest) {
  return handleVoice(req, {});
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const bodyParams = Object.fromEntries(new URLSearchParams(rawBody).entries());
  return handleVoice(req, bodyParams);
}

async function handleVoice(req: NextRequest, sigParams: Record<string, string>) {
  const slug = req.nextUrl.searchParams.get("slug")?.trim();

  const supabase = createServiceRoleClient();

  // Signature check — Twilio signs the FULL request URL incl. the ?slug= query.
  // For GET, `sigParams` is empty (all params are already in the URL); for POST
  // the body params are appended, matching Twilio's own signing.
  const authToken = await getTwilioAuthToken(supabase);
  if (authToken) {
    const signature = req.headers.get("x-twilio-signature") ?? "";
    const fullUrl = `${twilioRequestBaseUrl(req)}/api/twilio/voice${req.nextUrl.search}`;
    if (!validateTwilioSignature(fullUrl, sigParams, signature, authToken)) {
      console.warn("[twilio/voice] invalid signature");
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  // `From` / `To` are in the body on POST, in the query on GET.
  const from = sigParams.From ?? req.nextUrl.searchParams.get("From") ?? "";
  const to = sigParams.To ?? req.nextUrl.searchParams.get("To") ?? "";
  const bridgeWss = process.env.VOICE_BRIDGE_WSS_URL?.trim(); // e.g. wss://nailiq-voice.fly.dev/media

  // Fallbacks that keep the caller served even when AI is off / misconfigured.
  const sayUnavailable =
    `<Response><Say>Sorry, our booking assistant is not available right now. Please try again later.</Say><Hangup/></Response>`;

  if (!slug || !bridgeWss) return twimlResponse(sayUnavailable);

  const { data: salonRow } = await supabase
    .from("salons")
    .select("voice_ai_enabled")
    .eq("slug", slug)
    .maybeSingle();
  if (!salonRow || (salonRow as { voice_ai_enabled?: boolean | null }).voice_ai_enabled !== true) {
    return twimlResponse(sayUnavailable);
  }

  // Bridge the call audio to the voice bridge; hand it the salon slug + the
  // carrier-verified caller number so the agent can act on the caller's own
  // bookings without re-verification (caller-ID tier).
  return twimlResponse(
    `<Response>` +
      `<Connect>` +
        `<Stream url="${xmlEscape(bridgeWss)}">` +
          `<Parameter name="slug" value="${xmlEscape(slug)}"/>` +
          `<Parameter name="from" value="${xmlEscape(from)}"/>` +
          `<Parameter name="to" value="${xmlEscape(to)}"/>` +
        `</Stream>` +
      `</Connect>` +
    `</Response>`,
  );
}
