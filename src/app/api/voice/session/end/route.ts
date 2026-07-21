import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { toCanonicalPhone } from "@/shared/lib/toCanonicalPhone";

export const runtime = "nodejs";

type EndSessionBody = {
  sessionId:       string;
  durationSeconds: number;
  transcript?:     unknown[];
  status?:         "completed" | "failed" | "abandoned";
  clientName?:     string;
  clientPhone?:    string;
  /** The language the call ended in. On the phone the caller can switch mid-call
   *  (English → Spanish), and the session row must reflect where it finished. */
  language?:       string;
};

const SUPPORTED = ["vi", "en", "es", "fr", "zh"];

export async function POST(req: NextRequest) {
  let body: EndSessionBody;
  try {
    body = await req.json() as EndSessionBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { sessionId, durationSeconds, transcript, status = "completed", clientName, clientPhone, language } = body;
  if (!sessionId) return NextResponse.json({ error: "missing_session_id" }, { status: 400 });
  const lang = typeof language === "string" && SUPPORTED.includes(language) ? language : null;

  const supabase = createServiceRoleClient();

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
      duration_seconds: Math.max(0, Math.round(durationSeconds ?? 0)),
      ...(hasTranscript ? { transcript } : {}),
      ended_at:         new Date().toISOString(),
      ...(clientName  ? { client_name:  clientName  } : {}),
      ...(clientPhone ? { client_phone: toCanonicalPhone(clientPhone) ?? clientPhone } : {}),
      ...(lang        ? { language:     lang } : {}),
    })
    .eq("id", sessionId);

  if (error) {
    return NextResponse.json({ error: "update_failed", detail: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
