import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { buildVoiceSystemPrompt } from "@/shared/voice/buildSystemPrompt";
import { VOICE_TOOLS } from "@/shared/voice/tools";
import { REALTIME_CONFIG, validateRealtimeConfig } from "@/config/realtime";

export const runtime = "nodejs";
export const maxDuration = 30;

validateRealtimeConfig();

// Serialize any thrown value to a JSON-safe object — Error.message/stack are non-enumerable.
function serializeException(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      exception_type: err.constructor?.name ?? "Error",
      exception_name: err.name,
      exception_message: err.message,
      exception_stack: err.stack ?? null,
      exception_cause: err.cause != null ? String(err.cause) : null,
    };
  }
  return { exception_raw: String(err) };
}

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let phase = "init";

  try {
    // ── Phase: auth check ───────────────────────────────────────────────────
    phase = "auth_check";
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error("[voice/sdp] OPENAI_API_KEY not set");
      return NextResponse.json({ error: "no_openai_key" }, { status: 503 });
    }

    // ── Phase: parse body ───────────────────────────────────────────────────
    phase = "parse_body";
    let salon_slug: string, language: "en" | "vi", sdp_offer: string;
    try {
      ({ salon_slug, language = "vi", sdp_offer } = (await req.json()) as {
        salon_slug: string;
        language?: "en" | "vi";
        sdp_offer: string;
      });
    } catch (parseErr) {
      console.error("[voice/sdp] JSON parse failed:", parseErr);
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    if (!salon_slug || !sdp_offer) {
      return NextResponse.json({ error: "missing_params" }, { status: 400 });
    }

    console.info(
      `[voice/sdp] request: salon=${salon_slug} lang=${language} ` +
      `model=${REALTIME_CONFIG.model} voice=${REALTIME_CONFIG.voice} ` +
      `sdp_offer_bytes=${sdp_offer.length}`,
    );

    // ── Phase: salon config ─────────────────────────────────────────────────
    // DEMO bypass: skip Supabase entirely when salon_slug === "demo" or
    // NEXT_PUBLIC_VOICE_DEBUG=1. Used to isolate WebRTC/SDP without DB deps.
    const isDemo =
      salon_slug === "demo" ||
      process.env.NEXT_PUBLIC_VOICE_DEBUG === "1";

    let instructions: string;
    let salonName = salon_slug;
    let salonTimezone = "America/Vancouver";

    if (isDemo) {
      phase = "demo_bypass";
      console.info("[voice/sdp] DEMO mode — skipping Supabase, using stub config");
      instructions =
        "You are a helpful nail salon receptionist assistant for a demo salon. " +
        "You can answer questions about nail services and help with appointment scheduling. " +
        "This is a demo/debug session — no real booking will be made.";
    } else {
      // ── Phase: supabase lookup ────────────────────────────────────────────
      phase = "supabase_lookup";
      const supabase = createServiceRoleClient();

      const { data: salon, error: salonErr } = await supabase
        .from("salons")
        .select("id, name, timezone")
        .eq("slug", salon_slug)
        .maybeSingle();

      if (salonErr) {
        console.error("[voice/sdp] supabase salon query error:", salonErr);
        return NextResponse.json(
          { error: "supabase_error", detail: salonErr.message },
          { status: 500 },
        );
      }

      if (!salon) {
        console.error(`[voice/sdp] salon not found: ${salon_slug}`);
        return NextResponse.json({ error: "salon_not_found" }, { status: 404 });
      }

      // ── Phase: supabase services+staff ──────────────────────────────────
      phase = "supabase_services_staff";
      const [{ data: services, error: svcErr }, { data: staff, error: staffErr }] = await Promise.all([
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

      if (svcErr) console.warn("[voice/sdp] services query error:", svcErr.message);
      if (staffErr) console.warn("[voice/sdp] staff query error:", staffErr.message);

      // ── Phase: build system prompt ────────────────────────────────────────
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
    }

    // ── Phase: openai SDP exchange ──────────────────────────────────────────
    phase = "openai_fetch";
    const openaiUrl = `${REALTIME_CONFIG.sdpEndpoint}?model=${REALTIME_CONFIG.model}`;
    console.info(`[voice/sdp] → OpenAI: ${openaiUrl} sdp_bytes=${sdp_offer.length}`);

    let openaiRes: Response;
    try {
      openaiRes = await fetch(openaiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/sdp",
        },
        body: sdp_offer,
      });
    } catch (fetchErr) {
      // Network-level failure: DNS, TCP, TLS, timeout — no HTTP response at all
      const serialized = serializeException(fetchErr);
      console.error("[voice/sdp] fetch to OpenAI threw (network-level):", serialized);
      return NextResponse.json(
        {
          error: "openai_fetch_threw",
          phase: "openai_fetch",
          openai_url: openaiUrl,
          model: REALTIME_CONFIG.model,
          ...serialized,
        },
        { status: 502 },
      );
    }

    // ── Phase: read OpenAI response ─────────────────────────────────────────
    phase = "openai_read_response";
    const latencyMs = Date.now() - t0;
    const openaiContentType = openaiRes.headers.get("content-type") ?? "unknown";

    console.info(
      `[voice/sdp] OpenAI responded: status=${openaiRes.status} ` +
      `status_text="${openaiRes.statusText}" content-type="${openaiContentType}" ` +
      `latency=${latencyMs}ms`,
    );

    // Always read as text — SDP responses are plain text, NOT JSON
    let rawOpenaiBody: string;
    try {
      rawOpenaiBody = await openaiRes.text();
    } catch (readErr) {
      const serialized = serializeException(readErr);
      console.error("[voice/sdp] failed to read OpenAI response body:", serialized);
      return NextResponse.json(
        {
          error: "openai_body_read_failed",
          openai_status: openaiRes.status,
          openai_content_type: openaiContentType,
          model: REALTIME_CONFIG.model,
          ...serialized,
        },
        { status: 502 },
      );
    }

    console.info(
      `[voice/sdp] OpenAI body: content-type=${openaiContentType} ` +
      `bytes=${rawOpenaiBody.length} starts_with="${rawOpenaiBody.slice(0, 80).replace(/\n/g, "\\n")}"`,
    );

    if (!openaiRes.ok) {
      console.error(
        `[voice/sdp] OpenAI error: status=${openaiRes.status} ` +
        `model=${REALTIME_CONFIG.model} endpoint=${openaiUrl} ` +
        `body=${rawOpenaiBody}`,
      );
      return NextResponse.json(
        {
          error: "webrtc_connect_failed",
          phase: "openai_response_not_ok",
          openai_status: openaiRes.status,
          openai_status_text: openaiRes.statusText,
          openai_content_type: openaiContentType,
          // The full OpenAI body — may be JSON error or plain text
          detail: rawOpenaiBody,
          model_used: REALTIME_CONFIG.model,
          openai_endpoint: openaiUrl,
        },
        { status: 502 },
      );
    }

    // rawOpenaiBody IS the SDP answer (text/plain or application/sdp)
    const sdp_answer = rawOpenaiBody;

    if (!sdp_answer || sdp_answer.trim().length === 0) {
      console.error("[voice/sdp] OpenAI returned empty SDP answer");
      return NextResponse.json(
        {
          error: "empty_sdp_answer",
          openai_status: openaiRes.status,
          openai_content_type: openaiContentType,
          model: REALTIME_CONFIG.model,
        },
        { status: 502 },
      );
    }

    console.info(
      `[voice/sdp] success: latency=${latencyMs}ms sdp_answer_bytes=${sdp_answer.length}`,
    );

    return NextResponse.json({
      sdp_answer,
      session_config: {
        instructions,
        voice: REALTIME_CONFIG.voice,
        tools: isDemo ? [] : VOICE_TOOLS,
      },
      salon: {
        name: salonName,
        slug: salon_slug,
        timezone: salonTimezone,
      },
    });

  } catch (err) {
    // Catches anything not explicitly handled above
    const serialized = serializeException(err);
    console.error(`[voice/sdp] UNHANDLED EXCEPTION at phase="${phase}":`, serialized);
    return NextResponse.json(
      {
        error: "internal_server_error",
        phase,
        latency_ms: Date.now() - t0,
        model: REALTIME_CONFIG.model,
        ...serialized,
      },
      { status: 500 },
    );
  }
}
