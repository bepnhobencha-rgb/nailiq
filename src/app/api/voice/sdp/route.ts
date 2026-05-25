import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { buildVoiceSystemPrompt } from "@/shared/voice/buildSystemPrompt";
import { VOICE_TOOLS } from "@/shared/voice/tools";
import { REALTIME_CONFIG, validateRealtimeConfig } from "@/config/realtime";

export const runtime = "nodejs";
export const maxDuration = 30;

// Validate config at module load — fails fast on bad values
validateRealtimeConfig();

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

  console.info(
    `[voice/sdp] request: salon=${salon_slug} lang=${language} ` +
    `model=${REALTIME_CONFIG.model} voice=${REALTIME_CONFIG.voice}`,
  );

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

  // GA WebRTC SDP pattern: POST /v1/realtime?model=... with raw SDP body
  // NOT /v1/realtime/calls FormData — that endpoint does not exist
  const openaiUrl = `${REALTIME_CONFIG.sdpEndpoint}?model=${REALTIME_CONFIG.model}`;
  console.info(
    `[voice/sdp] forwarding SDP → ${openaiUrl} sdp_bytes=${sdp_offer.length}`,
  );

  const openaiRes = await fetch(openaiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/sdp",
    },
    body: sdp_offer,
  });

  const latencyMs = Date.now() - t0;

  if (!openaiRes.ok) {
    const errBody = await openaiRes.text();
    console.error(
      `[voice/sdp] OpenAI error: status=${openaiRes.status} latency=${latencyMs}ms ` +
      `model=${REALTIME_CONFIG.model} endpoint=${REALTIME_CONFIG.sdpEndpoint} ` +
      `body=${errBody}`,
    );
    return NextResponse.json(
      {
        error: "webrtc_connect_failed",
        openai_status: openaiRes.status,
        detail: errBody,
        model_used: REALTIME_CONFIG.model,
      },
      { status: 502 },
    );
  }

  const sdp_answer = await openaiRes.text();
  console.info(
    `[voice/sdp] SDP exchange ok: latency=${latencyMs}ms answer_bytes=${sdp_answer.length}`,
  );

  return NextResponse.json({
    sdp_answer,
    session_config: {
      instructions,
      voice: REALTIME_CONFIG.voice,
      tools: VOICE_TOOLS,
    },
    salon: {
      name: salon.name,
      slug: salon_slug,
      timezone: salon.timezone,
    },
  });
}
