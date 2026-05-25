import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { buildVoiceSystemPrompt } from "@/shared/voice/buildSystemPrompt";
import { VOICE_TOOLS } from "@/shared/voice/tools";

export const runtime = "nodejs";

const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2";
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE ?? "marin";

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("[voice/sdp] OPENAI_API_KEY not set");
    return NextResponse.json({ error: "no_openai_key" }, { status: 503 });
  }

  let salon_slug: string, language: "en" | "vi", sdp_offer: string;
  try {
    ({ salon_slug, language = "vi", sdp_offer } = (await req.json()) as {
      salon_slug: string;
      language?: "en" | "vi";
      sdp_offer: string;
    });
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!salon_slug || !sdp_offer) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  console.log(`[voice/sdp] request started: salon=${salon_slug} lang=${language}`);

  const supabase = createServiceRoleClient();

  const { data: salon } = await supabase
    .from("salons")
    .select("id, name, timezone")
    .eq("slug", salon_slug)
    .maybeSingle();

  if (!salon) {
    console.error(`[voice/sdp] salon not found: ${salon_slug}`);
    return NextResponse.json({ error: "salon_not_found" }, { status: 404 });
  }

  const [{ data: services }, { data: staff }] = await Promise.all([
    supabase
      .from("services")
      .select("id, name, duration_minutes, price_cents")
      .eq("salon_id", salon.id)
      .is("deleted_at", null)
      .order("name"),
    supabase
      .from("staff")
      .select("id, name")
      .eq("salon_id", salon.id)
      .is("deleted_at", null)
      .eq("status", "active")
      .order("name"),
  ]);

  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: (salon.timezone as string) ?? "America/Vancouver",
  });

  const instructions = buildVoiceSystemPrompt({
    salonName: (salon.name as string) || salon_slug,
    salonSlug: salon_slug,
    services: (services ?? []) as {
      id: string; name: string; name_vn?: string | null;
      duration_minutes: number | null; price_cents: number | null;
    }[],
    staff: (staff ?? []) as { id: string; name: string }[],
    language,
    timezone: (salon.timezone as string) || "America/Vancouver",
    today,
  });

  // Forward SDP offer to OpenAI GA Realtime API via /v1/realtime/calls (FormData)
  // Full session config baked in here so the model has instructions + tools from the first frame.
  // session.update sent later via data channel is a safety net only.
  console.log(`[voice/sdp] forwarding SDP to OpenAI model=${REALTIME_MODEL} voice=${REALTIME_VOICE} sdp_bytes=${sdp_offer.length}`);

  const sessionPayload = {
    type: "realtime",
    model: REALTIME_MODEL,
    modalities: ["audio", "text"],
    instructions,
    voice: REALTIME_VOICE,
    input_audio_format: "pcm16",
    output_audio_format: "pcm16",
    input_audio_transcription: { model: "gpt-realtime-whisper" },
    turn_detection: {
      type: "server_vad",
      threshold: 0.45,
      prefix_padding_ms: 200,
      silence_duration_ms: 700,
    },
    tools: VOICE_TOOLS,
    tool_choice: "auto",
    temperature: 0.7,
  };

  const form = new FormData();
  form.append("sdp", sdp_offer);
  form.append("session", JSON.stringify(sessionPayload));

  const openaiRes = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const latencyMs = Date.now() - t0;

  if (!openaiRes.ok) {
    const errBody = await openaiRes.text();
    console.error(`[voice/sdp] OpenAI error status=${openaiRes.status} latency=${latencyMs}ms body=${errBody}`);
    return NextResponse.json(
      { error: "webrtc_connect_failed", openai_status: openaiRes.status, detail: errBody },
      { status: 502 }
    );
  }

  const sdp_answer = await openaiRes.text();
  console.log(`[voice/sdp] SDP exchange ok status=200 latency=${latencyMs}ms answer_bytes=${sdp_answer.length}`);

  return NextResponse.json({
    sdp_answer,
    session_config: {
      instructions,
      voice: REALTIME_VOICE,
      tools: VOICE_TOOLS,
    },
    salon: {
      name: salon.name,
      slug: salon_slug,
      timezone: salon.timezone,
    },
  });
}
