/**
 * POST /api/voice/phone-config
 * Returns the Realtime session config (instructions + tools + voice + model) for
 * a salon, for the PHONE bridge to configure its OpenAI Realtime session.
 *
 * The web path (/api/voice/session) mints a browser ephemeral key; the phone
 * bridge instead runs server-side with the raw OPENAI_API_KEY and only needs the
 * "brain" (same buildSystemPrompt + REALTIME_TOOLS the web uses) — so the agent
 * is identical across web and phone; only the transport differs.
 *
 * Auth: shared secret (VOICE_BRIDGE_SECRET) — the bridge is server-to-server, not
 * a browser. Gated on the salon actually having voice AI enabled.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { loadSalonContext } from "@/shared/voiceai/loadSalonContext";
import { buildSystemPrompt } from "@/shared/voiceai/buildSystemPrompt";
import { REALTIME_TOOLS } from "@/shared/voiceai/realtimeTools";
import { VOICE_MODEL, SUPPORTED_LANGUAGES, type SupportedLanguage } from "@/shared/voiceai/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = process.env.VOICE_BRIDGE_SECRET?.trim();
  if (!secret || req.headers.get("x-voice-bridge-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { slug?: string; language?: string; from?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const slug = body.slug?.trim();
  if (!slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });

  // The caller's carrier-verified inbound number, forwarded by the phone bridge
  // (which only reaches this route with the shared secret checked above). Passed
  // into the prompt so the agent already knows the number and need not ask.
  // Personalisation still runs through lookup_customer, which keeps the tenant +
  // consent checks — this only removes the asking, not any safeguard.
  const from = typeof body.from === "string" && body.from.trim() ? body.from.trim() : null;

  const language: SupportedLanguage = SUPPORTED_LANGUAGES.includes(
    (body.language ?? "") as SupportedLanguage,
  )
    ? (body.language as SupportedLanguage)
    : "en";

  // Gate on the enable flag — same as the mutation route.
  const supabase = createServiceRoleClient();
  const { data: salonRow } = await supabase
    .from("salons")
    .select("voice_ai_enabled")
    .eq("slug", slug)
    .maybeSingle();
  if (!salonRow) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });
  if ((salonRow as { voice_ai_enabled?: boolean | null }).voice_ai_enabled !== true) {
    return NextResponse.json({ error: "voice_not_enabled" }, { status: 403 });
  }

  const ctx = await loadSalonContext(slug);
  if (!ctx) return NextResponse.json({ error: "context_load_failed" }, { status: 500 });

  // Open a session row so the phone call is recorded the same way a web call is.
  // The bridge threads the returned id onto its tool calls (→ tool_log) and posts
  // the transcript to /api/voice/session/end when the call ends. Best-effort: a
  // failure here must not stop the call from connecting.
  let sessionId: string | null = null;
  try {
    const { data: salonIdRow } = await supabase
      .from("salons").select("id").eq("slug", slug).maybeSingle();
    const salonId = (salonIdRow as { id?: string } | null)?.id ?? null;
    if (salonId) {
      const { data: sess } = await supabase
        .from("voice_ai_sessions")
        .insert({
          salon_id: salonId,
          status: "active",
          language,
          ...(from ? { client_phone: from.replace(/\D/g, "") } : {}),
        } as never)
        .select("id")
        .single();
      sessionId = (sess as { id?: string } | null)?.id ?? null;
    }
  } catch { /* best-effort — call still connects without a session row */ }

  return NextResponse.json({
    model: VOICE_MODEL,
    voice: ctx.personaVoice,
    instructions: buildSystemPrompt(ctx, language, from),
    tools: [...REALTIME_TOOLS],
    sessionId,
  });
}
