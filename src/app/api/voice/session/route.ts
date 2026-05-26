import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { loadSalonContext } from "@/shared/voiceai/loadSalonContext";
import { buildSystemPrompt } from "@/shared/voiceai/buildSystemPrompt";
import { REALTIME_TOOLS } from "@/shared/voiceai/realtimeTools";
import {
  VOICE_MODEL,
  OPENAI_CLIENT_SECRETS_URL,
  DEFAULT_VAD,
  SESSION_TTL_SECONDS,
  type SupportedLanguage,
} from "@/shared/voiceai/config";

export const runtime    = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const oaiKey = process.env.OPENAI_API_KEY;
  if (!oaiKey) {
    return NextResponse.json({ error: "no_openai_key" }, { status: 503 });
  }

  let salonSlug: string, language: SupportedLanguage;
  try {
    ({ salonSlug, language = "vi" } = await req.json() as { salonSlug: string; language?: SupportedLanguage });
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!salonSlug) return NextResponse.json({ error: "missing_salon_slug" }, { status: 400 });

  // Load salon + check voice_ai_enabled
  const supabase = createServiceRoleClient();
  const { data: salon } = await supabase
    .from("salons")
    .select("id, voice_ai_enabled, voice_ai_sessions_this_month, voice_ai_sessions_limit, subscription_plan")
    .eq("slug", salonSlug)
    .single();

  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = salon as any;

  // Gate: voice must be enabled for this salon
  if (!s.voice_ai_enabled) {
    return NextResponse.json({ error: "voice_not_enabled" }, { status: 403 });
  }

  // Gate: session limit
  const sessionLimit: number = s.voice_ai_sessions_limit ?? 200;
  const sessionCount: number = s.voice_ai_sessions_this_month ?? 0;
  if (sessionCount >= sessionLimit) {
    return NextResponse.json({ error: "session_limit_reached" }, { status: 429 });
  }

  // Load full context for system prompt
  const ctx = await loadSalonContext(salonSlug);
  if (!ctx) return NextResponse.json({ error: "context_load_failed" }, { status: 500 });

  const instructions = buildSystemPrompt(ctx, language);
  const voice        = ctx.personaVoice;

  // GA Realtime API: POST /v1/realtime/client_secrets
  // client_secrets uses a nested audio.input/output schema (different from WebSocket session.update)
  const clientSecretBody = {
    expires_after: { anchor: "created_at", seconds: SESSION_TTL_SECONDS },
    session: {
      type:         "realtime",
      model:        VOICE_MODEL,
      instructions,
      tools:        [...REALTIME_TOOLS],
      audio: {
        input: {
          transcription: { model: "gpt-4o-mini-transcribe" },
          turn_detection: DEFAULT_VAD,
        },
        output: { voice },
      },
    },
  };

  let oaiRes: Response;
  try {
    oaiRes = await fetch(OPENAI_CLIENT_SECRETS_URL, {
      method:  "POST",
      headers: { "Authorization": `Bearer ${oaiKey}`, "Content-Type": "application/json" },
      body:    JSON.stringify(clientSecretBody),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "network_error_session", detail: msg }, { status: 502 });
  }

  const oaiBody = await oaiRes.text();
  if (!oaiRes.ok) {
    return NextResponse.json(
      { error: "openai_session_failed", openai_status: oaiRes.status, openai_body: oaiBody },
      { status: 502 },
    );
  }

  let parsed: { value?: string; expires_at?: number; session?: { id?: string; model?: string } };
  try {
    parsed = JSON.parse(oaiBody) as typeof parsed;
  } catch {
    return NextResponse.json({ error: "openai_parse_failed", raw: oaiBody }, { status: 502 });
  }

  const ephemeralKey    = parsed.value;
  const openaiSessionId = parsed.session?.id;
  // Use the model OpenAI resolved — may differ from the alias we requested
  const resolvedModel   = parsed.session?.model ?? VOICE_MODEL;
  if (!ephemeralKey) {
    return NextResponse.json({ error: "missing_ephemeral_key", raw: oaiBody }, { status: 502 });
  }

  // Increment usage counter (best-effort — don't fail the request if this errors)
  try {
    await supabase.rpc("increment_voice_session_if_under_limit", { p_salon_id: salon.id });
  } catch { /* ignore */ }

  // Create voice session record (best-effort)
  let sessionRow: { id: string } | null = null;
  try {
    const { data } = await supabase
      .from("voice_ai_sessions")
      .insert({
        salon_id:          salon.id,
        openai_session_id: openaiSessionId ?? null,
        status:            "active",
        language,
      })
      .select("id")
      .single();
    sessionRow = data;
  } catch { /* ignore */ }

  return NextResponse.json({
    ephemeralKey,
    model:           resolvedModel,
    sessionId:       sessionRow?.id ?? null,
    expiresAt:       parsed.expires_at ?? Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    openaiSessionId: openaiSessionId ?? null,
    voice,
  });
}
