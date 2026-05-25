import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { buildVoiceSystemPrompt } from "@/shared/voice/buildSystemPrompt";
import { VOICE_TOOLS } from "@/shared/voice/tools";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "no_openai_key" }, { status: 503 });

  const { salon_slug, language = "vi" } = (await req.json()) as {
    salon_slug: string;
    language?: "en" | "vi";
  };

  if (!salon_slug) return NextResponse.json({ error: "missing_slug" }, { status: 400 });

  const supabase = createServiceRoleClient();

  const { data: salon } = await supabase
    .from("salons")
    .select("id, name, timezone")
    .eq("slug", salon_slug)
    .maybeSingle();

  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

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
    timeZone: salon.timezone ?? "America/Vancouver",
  }); // YYYY-MM-DD

  const instructions = buildVoiceSystemPrompt({
    salonName: (salon.name as string) || salon_slug,
    salonSlug: salon_slug,
    services: (services ?? []) as {
      id: string;
      name: string;
      name_vn?: string | null;
      duration_minutes: number | null;
      price_cents: number | null;
    }[],
    staff: (staff ?? []) as { id: string; name: string }[],
    language,
    timezone: (salon.timezone as string) || "America/Vancouver",
    today,
  });

  // Create ephemeral OpenAI Realtime session
  const openaiRes = await fetch("https://api.openai.com/v1/realtime/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-realtime-preview-2024-12-17",
      voice: "shimmer", // warm female voice — works well for both EN and VI
      modalities: ["audio", "text"],
      instructions,
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: { model: "whisper-1" },
      turn_detection: {
        type: "server_vad",
        threshold: 0.45,        // sensitive — catch soft Vietnamese speech
        prefix_padding_ms: 200,
        silence_duration_ms: 700, // don't cut off mid-sentence
        create_response: true,
      },
      tools: VOICE_TOOLS,
      tool_choice: "auto",
      temperature: 0.7,
    }),
  });

  if (!openaiRes.ok) {
    const body = await openaiRes.text();
    console.error("[voice/session] OpenAI error:", openaiRes.status, body);
    // Expose detail in non-prod or return as debug field
    return NextResponse.json({ error: "openai_session_failed", detail: body, status_code: openaiRes.status }, { status: 502 });
  }

  const session = (await openaiRes.json()) as {
    id: string;
    client_secret: { value: string; expires_at: number };
  };

  return NextResponse.json({
    session_id: session.id,
    client_secret: session.client_secret,
    salon: {
      name: salon.name,
      slug: salon_slug,
      timezone: salon.timezone,
    },
  });
}
