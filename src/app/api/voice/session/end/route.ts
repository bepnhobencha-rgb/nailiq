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
};

export async function POST(req: NextRequest) {
  let body: EndSessionBody;
  try {
    body = await req.json() as EndSessionBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { sessionId, durationSeconds, transcript, status = "completed", clientName, clientPhone } = body;
  if (!sessionId) return NextResponse.json({ error: "missing_session_id" }, { status: 400 });

  const supabase = createServiceRoleClient();

  // Never blank the transcript. Two writers share this column: logVoiceToolCall
  // appends a row per tool call DURING the session, and this route stores the
  // conversation the widget captured. Writing `transcript ?? []` meant any call
  // that ended without a captured conversation — a dropped connection, an early
  // close, a client bug — erased the tool log that was already there, which is
  // the only record of what the AI actually did. An empty payload now leaves
  // whatever is stored untouched.
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
    })
    .eq("id", sessionId);

  if (error) {
    return NextResponse.json({ error: "update_failed", detail: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
