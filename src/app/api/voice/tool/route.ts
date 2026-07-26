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
  // Trusted live-call transport fields. The model never sees or supplies these.
  phoneCallSid?: string;
  calledVerifiedPhone?: string;
  language?: string;
  // The caller's most recent transcribed utterance. Set ONLY by the trusted
  // phone bridge (from OpenAI's transcription events); used to verify the booking
  // time. Never accept it from the model/browser — a model could otherwise feed
  // a fake "utterance" that agrees with its own wrong time_slot.
  lastUserUtterance?: string;
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
  const trustedPhoneCallSid = fromBridge ? (body.phoneCallSid ?? null) : null;
  const trustedCalledPhone = fromBridge ? (body.calledVerifiedPhone ?? null) : null;
  const trustedLanguage = fromBridge ? (body.language ?? null) : null;
  // Trusted only from the bridge — same rule as the caller-ID above.
  const trustedUserUtterance = fromBridge ? (body.lastUserUtterance ?? null) : null;

  if (!toolName)  return NextResponse.json({ error: "missing_tool_name"  }, { status: 400 });
  if (!salonSlug) return NextResponse.json({ error: "missing_salon_slug" }, { status: 400 });

  let supabase: ReturnType<typeof createServiceRoleClient>;
  try {
    supabase = createServiceRoleClient();
  } catch {
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }

  // Per-leg timing for the voice latency investigation: how long the salon
  // gate query, the tool itself, and the tool_log write each took. Logged
  // server-side AND returned in a standard Server-Timing header so the voice
  // bridge can line the server's breakdown up against its own round-trip
  // numbers — no more guessing whether a slow tool was network or database.
  const tStart = Date.now();
  let gateMs = 0;

  // Gate the whole transactional tool surface on the salon actually having voice
  // AI enabled. The session-mint route already checks this, but this route was
  // directly POST-able with a known slug and no auth — letting a caller
  // create / cancel / reschedule bookings by phone even for salons with voice
  // AI off. Re-check here so the enable flag is enforced at the mutation point.
  {
    const tGate = Date.now();
    const { data: salonRow } = await supabase
      .from("salons")
      .select("voice_ai_enabled")
      .eq("slug", salonSlug)
      .maybeSingle();
    gateMs = Date.now() - tGate;
    if (!salonRow) {
      return NextResponse.json({ error: "salon_not_found" }, { status: 404 });
    }
    if ((salonRow as { voice_ai_enabled?: boolean | null }).voice_ai_enabled !== true) {
      return NextResponse.json({ error: "voice_not_enabled" }, { status: 403 });
    }
  }

  try {
    const tExec = Date.now();
    const res = await executeVoiceTool(
      supabase,
      salonSlug,
      toolName,
      toolArgs,
      sessionId,
      new URL(req.url).origin,
      // Only the phone bridge can set these (shared-secret check above); every
      // other surface leaves them null.
      {
        callerVerifiedPhone,
        trustedUserUtterance,
        trustedPhoneCallSid,
        trustedCalledPhone,
        trustedLanguage,
      },
    );
    const execMs = Date.now() - tExec;

    // Eval loop: record every tool invocation on the session row so calls can
    // be scored later (booked? errored? escalated?). Best-effort by design.
    const tLog = Date.now();
    if (sessionId) {
      await logVoiceToolCall(supabase, sessionId, toolName, res.status);
    }
    const logMs = Date.now() - tLog;

    res.headers.set("Server-Timing", `gate;dur=${gateMs}, exec;dur=${execMs}, log;dur=${logMs}`);
    console.log("[voice/tool] timing", JSON.stringify({ toolName, sessionId, gateMs, execMs, logMs, totalMs: Date.now() - tStart }));

    return res;
  } catch (err) {
    console.error("[voice/tool] unhandled error in", toolName, err);
    return NextResponse.json(
      { error: "internal_error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
