import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { loadSalonContext } from "@/shared/voiceai/loadSalonContext";
import { buildSystemPrompt } from "@/shared/voiceai/buildSystemPrompt";
import { REALTIME_TOOLS } from "@/shared/voiceai/realtimeTools";
import {
  VOICE_MODEL,
  OPENAI_CLIENT_SECRETS_URL,
  SESSION_TTL_SECONDS,
  type SupportedLanguage,
} from "@/shared/voiceai/config";
import { createVoiceSessionCapability } from "@/shared/voiceai/sessionCapability";
import {
  hasVoiceSessionSigningSecret,
  verifyVoiceSessionCapability,
} from "@/shared/voiceai/sessionCapability";
import { clientIp } from "@/shared/lib/inAppRateLimit";
import crypto from "node:crypto";
import { normalizeVoiceSessionChannel } from "@/shared/voiceai/clientDiagnostics";

export const runtime    = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const oaiKey = process.env.OPENAI_API_KEY;
  if (!oaiKey) {
    return NextResponse.json({ error: "no_openai_key" }, { status: 503 });
  }

  let salonSlug: string, language: SupportedLanguage;
  let renewal = false;
  let existingSessionId: string | null = null;
  let existingSessionCapability: string | null = null;
  let channel: unknown = "web_direct";
  try {
    ({
      salonSlug,
      language = "vi",
      renewal = false,
      sessionId: existingSessionId = null,
      sessionCapability: existingSessionCapability = null,
      channel = "web_direct",
    } = await req.json() as {
      salonSlug: string;
      language?: SupportedLanguage;
      renewal?: boolean;
      sessionId?: string | null;
      sessionCapability?: string | null;
      channel?: unknown;
    });
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!salonSlug) return NextResponse.json({ error: "missing_salon_slug" }, { status: 400 });
  const normalizedChannel = normalizeVoiceSessionChannel(channel);

  // Load salon + check voice_ai_enabled
  const supabase = createServiceRoleClient();
  const { data: salon } = await supabase
    .from("salons")
    .select("id, voice_ai_enabled")
    .eq("slug", salonSlug)
    .single();

  if (!salon) return NextResponse.json({ error: "salon_not_found" }, { status: 404 });

  // Gate: voice must be enabled for this salon
  if (!(salon as { voice_ai_enabled?: boolean | null }).voice_ai_enabled) {
    return NextResponse.json({ error: "voice_not_enabled" }, { status: 403 });
  }

  if (!hasVoiceSessionSigningSecret()) {
    return NextResponse.json(
      { error: "voice_session_signing_unavailable" },
      { status: 503 },
    );
  }

  // A renewal belongs to the existing browser call. It must prove possession
  // of that session and must not consume another monthly session or create an
  // orphan row. Also confirm the row belongs to the requested salon.
  if (renewal) {
    if (
      !existingSessionId ||
      !verifyVoiceSessionCapability(existingSessionId, existingSessionCapability)
    ) {
      return NextResponse.json({ error: "unauthorized_renewal" }, { status: 401 });
    }
    const { data: existingSession, error: existingSessionError } = await supabase
      .from("voice_ai_sessions")
      .select("id")
      .eq("id", existingSessionId)
      .eq("salon_id", salon.id)
      .maybeSingle();
    if (existingSessionError) {
      return NextResponse.json({ error: "renewal_check_failed" }, { status: 503 });
    }
    if (!existingSession) {
      return NextResponse.json({ error: "session_not_found" }, { status: 404 });
    }
  }

  // Atomic DB-backed rate limits protect the paid OpenAI mint endpoint. Fail
  // closed: an unavailable limiter must not turn into unlimited spend.
  const ipHash = crypto.createHash("sha256").update(clientIp(req)).digest("hex");
  const rateLimits = renewal
    ? [[`voice-renew:${existingSessionId}`, 2, 3600] as const]
    : [
        [`voice-session:ip:${ipHash}`, 5, 600] as const,
        [`voice-session:salon:${salon.id}`, 30, 600] as const,
      ];
  for (const [key, limit, seconds] of rateLimits) {
    const { data: allowed, error } = await supabase.rpc("rate_limit_hit", {
      p_key: key,
      p_limit: limit,
      p_window_seconds: seconds,
    });
    if (error) {
      return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
    }
    if (allowed !== true) {
      return NextResponse.json({ error: "voice_rate_limited" }, { status: 429 });
    }
  }

  // Load full context for system prompt
  const ctx = await loadSalonContext(salonSlug);
  if (!ctx) return NextResponse.json({ error: "context_load_failed" }, { status: 500 });

  const instructions = buildSystemPrompt(ctx, language);
  // The other language, built up front so a mid-call switch costs nothing. The
  // session language comes from the browser, which is often wrong: a Vietnamese
  // speaker landing on an English page got an English agent, said "Bạn nói gì?",
  // and the two of them spent two minutes failing to exchange a phone number.
  const altLanguage: SupportedLanguage = language === "vi" ? "en" : "vi";
  const altInstructions = buildSystemPrompt(ctx, altLanguage);
  const voice        = ctx.personaVoice;

  // Keep client_secrets body minimal — the endpoint rejects unknown/new fields.
  // Audio config (modalities, format, VAD, voice) is sent via session.update on the WebSocket.
  const clientSecretBody = {
    expires_after: { anchor: "created_at", seconds: SESSION_TTL_SECONDS },
    session: {
      type:         "realtime",
      model:        VOICE_MODEL,
      instructions,
      tools:        [...REALTIME_TOOLS],
    },
  };

  // Reserve monthly quota atomically before creating a paid OpenAI secret.
  // Renewal is the same call, so it deliberately skips this reservation.
  let quotaReserved = false;
  if (!renewal) {
    const { data: reserved, error: reserveError } = await supabase.rpc(
      "increment_voice_session_if_under_limit",
      { p_salon_id: salon.id },
    );
    if (reserveError) {
      return NextResponse.json({ error: "quota_unavailable" }, { status: 503 });
    }
    if (reserved !== true) {
      return NextResponse.json({ error: "session_limit_reached" }, { status: 429 });
    }
    quotaReserved = true;
  }

  const releaseQuota = async () => {
    if (!quotaReserved) return;
    quotaReserved = false;
    await supabase.rpc("release_voice_session_reservation", {
      p_salon_id: salon.id,
    });
  };

  let oaiRes: Response;
  try {
    oaiRes = await fetch(OPENAI_CLIENT_SECRETS_URL, {
      method:  "POST",
      headers: { "Authorization": `Bearer ${oaiKey}`, "Content-Type": "application/json" },
      body:    JSON.stringify(clientSecretBody),
    });
  } catch (err) {
    await releaseQuota();
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "network_error_session", detail: msg }, { status: 502 });
  }

  const oaiBody = await oaiRes.text();
  if (!oaiRes.ok) {
    await releaseQuota();
    // Surface rate-limit errors explicitly so the client can show a friendly message
    if (oaiRes.status === 429) {
      return NextResponse.json({ error: "openai_rate_limit" }, { status: 429 });
    }
    return NextResponse.json(
      { error: "openai_session_failed", openai_status: oaiRes.status, openai_body: oaiBody },
      { status: 502 },
    );
  }

  let parsed: { value?: string; expires_at?: number; session?: { id?: string; model?: string } };
  try {
    parsed = JSON.parse(oaiBody) as typeof parsed;
  } catch {
    await releaseQuota();
    return NextResponse.json({ error: "openai_parse_failed", raw: oaiBody }, { status: 502 });
  }

  const ephemeralKey    = parsed.value;
  const openaiSessionId = parsed.session?.id;
  // Use the model OpenAI resolved — may differ from the alias we requested
  const resolvedModel   = parsed.session?.model ?? VOICE_MODEL;
  if (!ephemeralKey) {
    await releaseQuota();
    return NextResponse.json({ error: "missing_ephemeral_key", raw: oaiBody }, { status: 502 });
  }

  // Initial mint creates the durable call row. Renewal keeps using the original
  // row and capability, so one real call remains one metered session.
  let sessionRow: { id: string } | null = null;
  if (renewal) {
    sessionRow = { id: existingSessionId! };
  } else {
    const { data, error } = await supabase
      .from("voice_ai_sessions")
      .insert({
        salon_id:          salon.id,
        openai_session_id: openaiSessionId ?? null,
        model:             resolvedModel,
        status:            "active",
        language,
        tool_log: [{
          at: new Date().toISOString(),
          type: "session_start",
          channel: normalizedChannel,
        }],
      })
      .select("id")
      .single();
    if (error || !data) {
      await releaseQuota();
      return NextResponse.json({ error: "session_record_failed" }, { status: 503 });
    }
    sessionRow = data;
  }

  const sessionCapability = sessionRow
    ? createVoiceSessionCapability(sessionRow.id)
    : null;
  if (!sessionCapability) {
    await releaseQuota();
    return NextResponse.json(
      { error: "voice_session_signing_unavailable" },
      { status: 503 },
    );
  }

  return NextResponse.json({
    ephemeralKey,
    model:           resolvedModel,
    sessionId:       sessionRow?.id ?? null,
    sessionCapability,
    expiresAt:       parsed.expires_at ?? Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    openaiSessionId: openaiSessionId ?? null,
    voice,
    instructions,   // returned so the client can reinforce them in session.update
    language,
    // Client swaps to these when it hears the caller using the other language.
    altLanguage,
    altInstructions,
  });
}
