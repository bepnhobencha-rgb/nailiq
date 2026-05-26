/**
 * GA WebRTC pattern — server creates an ephemeral key, client does SDP directly.
 *
 * Flow:
 *   1. Client calls POST /api/voice/session → gets ephemeral_key
 *   2. Client creates RTCPeerConnection + SDP offer
 *   3. Client POSTs SDP offer directly to OpenAI:
 *        POST https://api.openai.com/v1/realtime?model=...
 *        Authorization: Bearer <ephemeral_key>   ← NOT the main API key
 *        Content-Type: application/sdp
 *   4. Client receives SDP answer + sets remote description
 *   5. Data channel opens → session is live
 *
 * Server-proxy SDP (the old /api/voice/sdp route) used the main API key and
 * triggers beta_api_shape_disabled. This ephemeral-key approach is the
 * documented GA pattern per the OpenAI SDK.
 */

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { buildVoiceSystemPrompt } from "@/shared/voice/buildSystemPrompt";
import { VOICE_TOOLS } from "@/shared/voice/tools";
import { REALTIME_CONFIG, validateRealtimeConfig } from "@/config/realtime";

export const runtime = "nodejs";
export const maxDuration = 30;

validateRealtimeConfig();

function serializeException(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      exception_type: err.constructor?.name ?? "Error",
      exception_name: err.name,
      exception_message: err.message,
      exception_stack: err.stack ?? null,
    };
  }
  return { exception_raw: String(err) };
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let phase = "init";

  try {
    phase = "auth_check";
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: "no_openai_key" }, { status: 503 });
    }

    phase = "parse_body";
    let salon_slug: string, language: "en" | "vi";
    try {
      ({ salon_slug, language = "vi" } = (await req.json()) as {
        salon_slug: string;
        language?: "en" | "vi";
      });
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    if (!salon_slug) {
      return NextResponse.json({ error: "missing_salon_slug" }, { status: 400 });
    }

    console.info(
      `[voice/session] request: salon=${salon_slug} lang=${language} model=${REALTIME_CONFIG.model}`,
    );

    // ── Salon config ──────────────────────────────────────────────────────────
    const isDemo =
      salon_slug === "demo" ||
      process.env.NEXT_PUBLIC_VOICE_DEBUG === "1";

    let instructions: string;
    let salonName = salon_slug;
    let salonTimezone = "America/Vancouver";
    let tools: typeof VOICE_TOOLS | readonly [] = [];

    if (isDemo) {
      phase = "demo_bypass";
      console.info("[voice/session] DEMO mode — skipping Supabase");
      instructions =
        "You are a helpful nail salon receptionist for a demo salon. " +
        "Answer questions about nail services and help with appointment scheduling. " +
        "This is a debug session — no real booking will be made.";
    } else {
      phase = "supabase_lookup";
      const supabase = createServiceRoleClient();

      const { data: salon, error: salonErr } = await supabase
        .from("salons")
        .select("id, name, timezone")
        .eq("slug", salon_slug)
        .maybeSingle();

      if (salonErr) {
        return NextResponse.json(
          { error: "supabase_error", detail: salonErr.message },
          { status: 500 },
        );
      }
      if (!salon) {
        return NextResponse.json({ error: "salon_not_found" }, { status: 404 });
      }

      phase = "supabase_services_staff";
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

      phase = "build_prompt";
      salonName = (salon.name as string) || salon_slug;
      salonTimezone = (salon.timezone as string) || "America/Vancouver";
      const today = new Date().toLocaleDateString("en-CA", { timeZone: salonTimezone });

      instructions = buildVoiceSystemPrompt({
        salonName,
        salonSlug: salon_slug,
        services: (services ?? []) as {
          id: string; name: string; name_vn?: string | null;
          duration_minutes: number | null; price_cents: number | null;
        }[],
        staff: (staff ?? []) as { id: string; name: string }[],
        language,
        timezone: salonTimezone,
        today,
      });
      tools = VOICE_TOOLS;
    }

    // ── Create ephemeral token via OpenAI SDK ─────────────────────────────────
    phase = "create_ephemeral_token";

    const openai = new OpenAI({ apiKey });

    // GA ephemeral session payload — minimal valid fields only.
    // DO NOT include beta-era fields: modalities, input_audio_format,
    // output_audio_format, input_audio_transcription — those go in
    // session.update after the data channel opens.
    const sessionPayload = {
      type: "realtime",
      model: REALTIME_CONFIG.model as string,
      instructions,
      voice: REALTIME_CONFIG.voice as string,
      turn_detection: {
        type: "server_vad",
        threshold: REALTIME_CONFIG.vad.threshold,
        prefix_padding_ms: REALTIME_CONFIG.vad.prefixPaddingMs,
        silence_duration_ms: REALTIME_CONFIG.vad.silenceDurationMs,
      },
      tools: (tools as unknown) as unknown[],
      tool_choice: tools.length > 0 ? "auto" : "none",
      temperature: REALTIME_CONFIG.temperature,
    };

    console.info("[voice/session] ephemeral session payload", JSON.stringify(sessionPayload, null, 2));

    const session = await openai.realtime.clientSecrets.create({
      session: sessionPayload as unknown as Parameters<typeof openai.realtime.clientSecrets.create>[0]["session"],
    });

    const latencyMs = Date.now() - t0;
    console.info(
      `[voice/session] ephemeral key created: expires_at=${session.expires_at} latency=${latencyMs}ms`,
    );

    return NextResponse.json({
      // Ephemeral key — client uses this for SDP exchange directly with OpenAI
      ephemeral_key: session.value,
      expires_at: session.expires_at,
      // Config the client needs for session.update after DC opens
      session_config: {
        model: REALTIME_CONFIG.model,
        voice: REALTIME_CONFIG.voice,
        instructions,
        tools,
        transcription_model: REALTIME_CONFIG.transcriptionModel,
      },
      salon: {
        name: salonName,
        slug: salon_slug,
        timezone: salonTimezone,
      },
    });

  } catch (err) {
    const serialized = serializeException(err);
    console.error(`[voice/session] UNHANDLED at phase="${phase}":`, serialized);
    return NextResponse.json(
      {
        error: "internal_server_error",
        phase,
        latency_ms: Date.now() - t0,
        ...serialized,
      },
      { status: 500 },
    );
  }
}
