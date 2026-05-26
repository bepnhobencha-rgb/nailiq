import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { buildVoiceSystemPrompt } from "@/shared/voice/buildSystemPrompt";
import { VOICE_TOOLS } from "@/shared/voice/tools";

export const runtime = "nodejs";
export const maxDuration = 30;

const OPENAI_SESSIONS_URL = "https://api.openai.com/v1/realtime/sessions";
const REALTIME_MODEL    = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2025-08-28";
const REALTIME_VOICE    = process.env.OPENAI_REALTIME_VOICE ?? "shimmer";

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "no_openai_key" }, { status: 503 });

  let salon_slug: string, language: "en" | "vi";
  try {
    ({ salon_slug, language = "vi" } = await req.json() as { salon_slug: string; language?: "en" | "vi" });
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!salon_slug) return NextResponse.json({ error: "missing_salon_slug" }, { status: 400 });

  // ── Salon config ──────────────────────────────────────────────────────────
  const isDemo = salon_slug === "demo" || process.env.NEXT_PUBLIC_VOICE_DEBUG === "1";
  let instructions: string;
  let salonName = salon_slug;
  let salonTimezone = "America/Vancouver";
  let tools: typeof VOICE_TOOLS | readonly [] = [];

  if (isDemo) {
    instructions = "You are a helpful nail salon receptionist for a demo salon. This is a debug session — no real booking will be made.";
  } else {
    const supabase = createServiceRoleClient();
    const { data: salon, error: salonErr } = await supabase
      .from("salons").select("id, name, timezone").eq("slug", salon_slug).maybeSingle();
    if (salonErr) return NextResponse.json({ error: "supabase_error", detail: salonErr.message }, { status: 500 });
    if (!salon)   return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

    const [{ data: services }, { data: staff }] = await Promise.all([
      supabase.from("services").select("id, name, duration_minutes, price_cents")
        .eq("salon_id", salon.id).is("deleted_at", null).order("name"),
      supabase.from("staff").select("id, name")
        .eq("salon_id", salon.id).is("deleted_at", null).eq("status", "active").order("name"),
    ]);

    salonName    = String(salon.name ?? salon_slug);
    salonTimezone = String(salon.timezone ?? "America/Vancouver");
    instructions = buildVoiceSystemPrompt({
      salonName, salonSlug: salon_slug,
      services: (services ?? []) as { id: string; name: string; name_vn?: string | null; duration_minutes: number | null; price_cents: number | null }[],
      staff:    (staff ?? []) as { id: string; name: string }[],
      language, timezone: salonTimezone,
      today: new Date().toLocaleDateString("en-CA", { timeZone: salonTimezone }),
    });
    tools = VOICE_TOOLS;
  }

  // ── Mint ephemeral token ──────────────────────────────────────────────────
  // GA endpoint: POST /v1/realtime/sessions — minimal payload only
  const payload = { model: REALTIME_MODEL };
  console.info("[voice/session] POST", OPENAI_SESSIONS_URL, JSON.stringify(payload));

  const res = await fetch(OPENAI_SESSIONS_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const raw = await res.text();
  console.info(`[voice/session] status=${res.status} body=${raw}`);

  if (!res.ok) {
    return NextResponse.json({
      error: "session_create_failed", openai_status: res.status, openai_body: raw,
    }, { status: 502 });
  }

  const data = JSON.parse(raw) as {
    id?: string;
    client_secret?: { value?: string; expires_at?: number };
    expires_at?: number;
  };

  const ephemeral_key = data.client_secret?.value;
  const expires_at    = data.client_secret?.expires_at ?? data.expires_at;

  if (!ephemeral_key) {
    return NextResponse.json({ error: "no_ephemeral_key", openai_response: data }, { status: 502 });
  }

  console.info(`[voice/session] key=${ephemeral_key.slice(0, 8)}… expires_at=${expires_at}`);

  return NextResponse.json({
    ephemeral_key,
    expires_at,
    session_config: {
      model: REALTIME_MODEL,
      voice: REALTIME_VOICE,
      instructions,
      tools,
      transcription_model: "whisper-1",
    },
    salon: { name: salonName, slug: salon_slug, timezone: salonTimezone },
  });
}
