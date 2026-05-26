/**
 * GA WebRTC pattern — server mints ephemeral key, client does SDP directly.
 *
 * Flow:
 *   1. POST /api/voice/session → ephemeral_key (ek_...)
 *   2. Client creates RTCPeerConnection + SDP offer
 *   3. Client POSTs SDP to https://api.openai.com/v1/realtime?model=...
 *      with Authorization: Bearer <ephemeral_key>
 *   4. SDP answer received → setRemoteDescription
 *   5. Data channel opens → session.update → live
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { buildVoiceSystemPrompt } from "@/shared/voice/buildSystemPrompt";
import { VOICE_TOOLS } from "@/shared/voice/tools";
import { REALTIME_CONFIG } from "@/config/realtime";

export const runtime = "nodejs";
export const maxDuration = 30;

const SESSIONS_ENDPOINT = "https://api.openai.com/v1/realtime/sessions";

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

    // ── Mint ephemeral token — raw fetch, minimal GA payload ──────────────────
    phase = "create_ephemeral_token";

    // Start with the absolute minimum: just model.
    // All other config (voice, instructions, tools, etc.) is sent via
    // session.update after the data channel opens.
    const sessionPayload = {
      model: REALTIME_CONFIG.model,
    };

    console.info("[voice/session] POST", SESSIONS_ENDPOINT, JSON.stringify(sessionPayload));

    const openaiRes = await fetch(SESSIONS_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sessionPayload),
    });

    const rawBody = await openaiRes.text();
    console.info(
      `[voice/session] OpenAI response: status=${openaiRes.status} body=${rawBody}`,
    );

    if (!openaiRes.ok) {
      return NextResponse.json(
        {
          error: "session_create_failed",
          openai_status: openaiRes.status,
          openai_body: rawBody,
          payload_sent: sessionPayload,
          phase,
        },
        { status: 502 },
      );
    }

    const data = JSON.parse(rawBody) as {
      client_secret?: { value?: string; expires_at?: number };
      id?: string;
      expires_at?: number;
    };

    // GA response shape: { client_secret: { value: "ek_...", expires_at: ... } }
    const ephemeral_key = data.client_secret?.value;
    const expires_at = data.client_secret?.expires_at ?? data.expires_at;

    if (!ephemeral_key) {
      return NextResponse.json(
        {
          error: "no_ephemeral_key",
          openai_response: data,
          phase,
        },
        { status: 502 },
      );
    }

    const latencyMs = Date.now() - t0;
    console.info(
      `[voice/session] ephemeral key minted: expires_at=${expires_at} latency=${latencyMs}ms`,
    );

    return NextResponse.json({
      ephemeral_key,
      expires_at,
      // Client uses this for session.update after data channel opens
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
