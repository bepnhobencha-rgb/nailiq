import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { executeVoiceTool, logVoiceToolCall } from "@/shared/voiceai/toolExecutor";

export const runtime     = "nodejs";
export const maxDuration = 30;

// The tool handlers themselves live in @/shared/voiceai/toolExecutor so the
// text-chat receptionist (/api/chat/booking) reuses the exact same logic.
// This route stays the thin, voice-gated HTTP surface for the WebRTC client.

type ToolCallBody = {
  // Primary field names used by the WebRTC client handler.
  toolName?:   string;
  toolArgs?:   Record<string, unknown>;
  salonSlug?:  string;
  sessionId?:  string;
  // Alternate field names accepted from external / direct API callers.
  toolInput?:  Record<string, unknown>;
  salonId?:    string;
  // Carrier-verified caller-ID (E.164). Set ONLY by the trusted phone bridge
  // (Twilio `From`); absent on web. Never accept it from the model/browser.
  callerVerifiedPhone?: string;
};

export async function POST(req: NextRequest) {
  let body: ToolCallBody;
  try {
    body = await req.json() as ToolCallBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Accept both field name conventions so the route is robust to
  // WebRTC client calls (toolArgs / salonSlug) and direct API calls
  // (toolInput / salonId).
  const toolName  = body.toolName;
  const toolArgs  = body.toolArgs ?? body.toolInput ?? {};
  const salonSlug = body.salonSlug ?? body.salonId;
  const sessionId = body.sessionId ?? null;
  // Caller-ID is honoured ONLY when the request proves it is the phone bridge
  // (shared secret). A web/browser or attacker cannot set it — otherwise anyone
  // could claim a carrier-verified number and bypass OTP on mutations.
  const bridgeSecret = process.env.VOICE_BRIDGE_SECRET?.trim();
  const fromBridge = Boolean(bridgeSecret) && req.headers.get("x-voice-bridge-secret") === bridgeSecret;
  const callerVerifiedPhone = fromBridge ? (body.callerVerifiedPhone ?? null) : null;

  if (!toolName)  return NextResponse.json({ error: "missing_tool_name"  }, { status: 400 });
  if (!salonSlug) return NextResponse.json({ error: "missing_salon_slug" }, { status: 400 });

  let supabase: ReturnType<typeof createServiceRoleClient>;
  try {
    supabase = createServiceRoleClient();
  } catch {
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }

  // Gate the whole transactional tool surface on the salon actually having voice
  // AI enabled. The session-mint route already checks this, but this route was
  // directly POST-able with a known slug and no auth — letting a caller
  // create / cancel / reschedule bookings by phone even for salons with voice
  // AI off. Re-check here so the enable flag is enforced at the mutation point.
  {
    const { data: salonRow } = await supabase
      .from("salons")
      .select("voice_ai_enabled")
      .eq("slug", salonSlug)
      .maybeSingle();
    if (!salonRow) {
      return NextResponse.json({ error: "salon_not_found" }, { status: 404 });
    }
    if ((salonRow as { voice_ai_enabled?: boolean | null }).voice_ai_enabled !== true) {
      return NextResponse.json({ error: "voice_not_enabled" }, { status: 403 });
    }
  }

  try {
    const res = await executeVoiceTool(
      supabase,
      salonSlug,
      toolName,
      toolArgs,
      sessionId,
      new URL(req.url).origin,
      // Only the phone bridge can set this (shared-secret check above); every
      // other surface leaves it null and falls through to the OTP tier.
      { callerVerifiedPhone },
    );

    // Eval loop: record every tool invocation on the session row so calls can
    // be scored later (booked? errored? escalated?). Best-effort by design.
    if (sessionId) {
      await logVoiceToolCall(supabase, sessionId, toolName, res.status);
    }

    return res;
  } catch (err) {
    console.error("[voice/tool] unhandled error in", toolName, err);
    return NextResponse.json(
      { error: "internal_error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
