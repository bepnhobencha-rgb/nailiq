/**
 * POST /api/voice/phone-config
 * Returns the Realtime session config (instructions + tools + voice + model) for
 * a salon, for the PHONE bridge to configure its OpenAI Realtime session.
 *
 * The web path (/api/voice/session) mints a browser ephemeral key; the phone
 * bridge instead runs server-side with the raw OPENAI_API_KEY. Phone sessions
 * use a compact, safety-equivalent prompt/tool projection because repeating the
 * verbose web context on every spoken turn can exhaust Realtime token limits.
 *
 * Auth: shared secret (VOICE_BRIDGE_SECRET) — the bridge is server-to-server, not
 * a browser. Gated on the salon actually having voice AI enabled.
 */
import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { loadSalonContext } from "@/shared/voiceai/loadSalonContext";
import {
  buildPhoneGreeting,
  buildPhoneSystemPrompt,
} from "@/shared/voiceai/buildPhoneSystemPrompt";
import { PHONE_REALTIME_TOOLS } from "@/shared/voiceai/realtimeTools";
import {
  VOICE_MODEL,
  normalizeAllowedLanguages,
  resolveAllowedLanguage,
  type SupportedLanguage,
} from "@/shared/voiceai/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = process.env.VOICE_BRIDGE_SECRET?.trim();
  if (!secret || req.headers.get("x-voice-bridge-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { slug?: string; language?: string; from?: string; newSession?: boolean };
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

  // The bridge re-fetches this route mid-call to switch language (it detects the
  // caller's language from the transcript). newSession=true marks the FIRST fetch
  // of a call — the one that opens a session row — so a language switch does not
  // create a duplicate row.
  const newSession = body.newSession === true;

  // Gate on the enable flag — same as the mutation route.
  const supabase = createServiceRoleClient();
  const { data: salonRow } = await supabase
    .from("salons")
    .select("voice_ai_enabled, voice_ai_default_language, voice_ai_allowed_languages")
    .eq("slug", slug)
    .maybeSingle();
  if (!salonRow) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });
  if ((salonRow as { voice_ai_enabled?: boolean | null }).voice_ai_enabled !== true) {
    return NextResponse.json({ error: "voice_not_enabled" }, { status: 403 });
  }

  // Resolve the language: an explicit request (the bridge's mid-call switch)
  // wins; otherwise open in the salon's dedicated Voice AI language. Keep this
  // separate from default_notification_locale: staff/customer notifications
  // currently support a narrower language set than the live receptionist.
  const configuredDefault =
    (salonRow as { voice_ai_default_language?: string | null })
      .voice_ai_default_language;
  const allowedLanguages = normalizeAllowedLanguages(
    (salonRow as { voice_ai_allowed_languages?: unknown })
      .voice_ai_allowed_languages,
  );
  const requested = typeof body.language === "string"
    ? body.language.trim()
    : null;
  const language: SupportedLanguage = resolveAllowedLanguage(
    requested,
    configuredDefault,
    allowedLanguages,
  );

  const ctx = await loadSalonContext(slug);
  if (!ctx) return NextResponse.json({ error: "context_load_failed" }, { status: 500 });

  // Open a session row so the phone call is recorded the same way a web call is.
  // The bridge threads the returned id onto its tool calls (→ tool_log) and posts
  // the transcript to /api/voice/session/end when the call ends. Best-effort: a
  // failure here must not stop the call from connecting.
  let sessionId: string | null = null;
  try {
    if (!newSession) throw new Error("skip");   // language-switch re-fetch — no new row
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
    instructions: buildPhoneSystemPrompt({ ...ctx, allowedLanguages }, language, from),
    greeting: buildPhoneGreeting(ctx, language),
    tools: [...PHONE_REALTIME_TOOLS],
    sessionId,
    language,   // so the bridge knows which language this config is for
    allowedLanguages,
  });
}
