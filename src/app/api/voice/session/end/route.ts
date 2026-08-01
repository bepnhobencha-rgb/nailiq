import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";
import { normalizeVoiceSessionSeconds } from "@/shared/voiceai/sessionDuration";
import { verifyVoiceSessionCapability } from "@/shared/voiceai/sessionCapability";
import {
  estimateRealtimeCostUsd,
  normalizeRealtimeUsage,
} from "@/shared/voiceai/realtimeUsage";

export const runtime = "nodejs";

type EndSessionBody = {
  sessionId:       string;
  durationSeconds: number;
  transcript?:     unknown[];
  status?:         "completed" | "failed" | "abandoned";
  clientName?:     string;
  clientPhone?:    string;
  /** Aggregate counters only. The server validates them and owns all pricing. */
  realtimeUsage?:  unknown;
  /** The language the call ended in. On the phone the caller can switch mid-call
   *  (English → Spanish), and the session row must reflect where it finished. */
  language?:       string;
};

const SUPPORTED = ["vi", "en", "es", "fr", "zh"];
const SESSION_STATUSES = new Set(["completed", "failed", "abandoned"]);

export async function POST(req: NextRequest) {
  let body: EndSessionBody;
  try {
    body = await req.json() as EndSessionBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const {
    sessionId,
    durationSeconds,
    transcript,
    status: requestedStatus = "completed",
    clientName,
    clientPhone,
    realtimeUsage,
    language,
  } = body;
  if (!sessionId) return NextResponse.json({ error: "missing_session_id" }, { status: 400 });

  // This route writes with service-role privileges. The Fly bridge authenticates
  // with its shared secret; a browser receives a capability bound to the exact
  // session id from /api/voice/session. Never accept an unsigned session update.
  const bridgeSecret = process.env.VOICE_BRIDGE_SECRET?.trim();
  const fromBridge = Boolean(bridgeSecret) &&
    req.headers.get("x-voice-bridge-secret") === bridgeSecret;
  const browserCapability = req.headers.get("x-voice-session-token");
  if (!fromBridge && !verifyVoiceSessionCapability(sessionId, browserCapability)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const lang = typeof language === "string" && SUPPORTED.includes(language) ? language : null;
  const status = SESSION_STATUSES.has(requestedStatus) ? requestedStatus : "failed";

  const supabase = createServiceRoleClient();

  const { data: sessionRow, error: sessionReadError } = await supabase
    .from("voice_ai_sessions")
    .select("model")
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionReadError) {
    return NextResponse.json({ error: "session_read_failed" }, { status: 500 });
  }
  if (!sessionRow) {
    return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  }

  const hasRealtimeUsage = realtimeUsage !== null &&
    typeof realtimeUsage === "object" && !Array.isArray(realtimeUsage);
  const normalizedUsage = hasRealtimeUsage
    ? normalizeRealtimeUsage(realtimeUsage)
    : null;
  const costEstimate = normalizedUsage
    ? estimateRealtimeCostUsd(
        (sessionRow as { model?: string | null }).model,
        normalizedUsage,
      )
    : null;

  // `transcript` is now this route's column alone — the per-tool-call record
  // moved to `tool_log`, which logVoiceToolCall appends to during the session.
  // While they shared one column the later write won, so a call that produced a
  // real conversation lost its tool log and a call that produced none erased it.
  //
  // Still guarded against blanking: a dropped connection or an early close
  // sends nothing, and overwriting a captured conversation with [] loses the
  // only record of what was said.
  const hasTranscript = Array.isArray(transcript) && transcript.length > 0;

  const { error } = await supabase
    .from("voice_ai_sessions")
    .update({
      status,
      // Treat every caller (browser and bridge) as untrusted. This also keeps a
      // future client regression from persisting epoch-sized durations again.
      duration_seconds: normalizeVoiceSessionSeconds(durationSeconds),
      ...(hasTranscript ? { transcript } : {}),
      ended_at:         new Date().toISOString(),
      ...(clientName  ? { client_name:  clientName  } : {}),
      ...(clientPhone ? { client_phone: toCanonicalPhone(clientPhone) ?? clientPhone } : {}),
      ...(lang        ? { language:     lang } : {}),
      ...(normalizedUsage ? {
        realtime_usage: {
          ...normalizedUsage,
          model: (sessionRow as { model?: string | null }).model ?? null,
          pricingAsOf: costEstimate?.pricingAsOf ?? null,
        },
        // Unknown/new models remain visibly unpriced instead of silently using
        // a stale rate card. A known model with zero usage is legitimately $0.
        estimated_cost_usd: costEstimate?.estimatedCostUsd ?? null,
      } : {}),
    })
    .eq("id", sessionId);

  if (error) {
    return NextResponse.json({ error: "update_failed", detail: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
