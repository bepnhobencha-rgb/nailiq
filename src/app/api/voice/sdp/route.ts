/**
 * SDP proxy — receives the client's SDP offer + ephemeral key,
 * forwards to OpenAI server-side (avoids browser CORS on application/sdp),
 * returns the SDP answer.
 *
 * Auth: uses the short-lived ephemeral key minted by /api/voice/session,
 * NOT the main OPENAI_API_KEY.  The main key never touches this route.
 */

import { NextRequest, NextResponse } from "next/server";
import { REALTIME_CONFIG } from "@/config/realtime";

export const runtime = "nodejs";
export const maxDuration = 30;

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
    phase = "parse_body";
    let ephemeral_key: string, sdp_offer: string;
    try {
      ({ ephemeral_key, sdp_offer } = (await req.json()) as {
        ephemeral_key: string;
        sdp_offer: string;
      });
    } catch {
      return NextResponse.json({ error: "invalid_json" }, { status: 400 });
    }

    if (!ephemeral_key || !sdp_offer) {
      return NextResponse.json({ error: "missing_params: ephemeral_key + sdp_offer required" }, { status: 400 });
    }

    phase = "sdp_exchange";
    const openaiUrl = `${REALTIME_CONFIG.sdpEndpoint}?model=${REALTIME_CONFIG.model}`;

    // Explicit header object — nothing hidden, no defaults, nothing from SDK
    const outgoingHeaders: Record<string, string> = {
      "Authorization": `Bearer ${ephemeral_key}`,
      "Content-Type": "application/sdp",
    };

    console.info("[voice/sdp] request →", {
      url: openaiUrl,
      method: "POST",
      headers: { ...outgoingHeaders, Authorization: `Bearer ${ephemeral_key.slice(0, 8)}…` },
      key_length: ephemeral_key.length,
      sdp_bytes: sdp_offer.length,
      sdp_preview: sdp_offer.slice(0, 200).replace(/\r\n/g, "↵"),
    });

    let openaiRes: Response;
    try {
      openaiRes = await fetch(openaiUrl, {
        method: "POST",
        headers: outgoingHeaders,
        body: sdp_offer,
        cache: "no-store",
      });
    } catch (fetchErr) {
      const serialized = serializeException(fetchErr);
      console.error("[voice/sdp] fetch threw (network-level):", serialized);
      return NextResponse.json(
        { error: "sdp_fetch_threw", openai_url: openaiUrl, ...serialized },
        { status: 502 },
      );
    }

    const rawBody = await openaiRes.text();
    const latencyMs = Date.now() - t0;

    // Log every response header for diagnosis
    const responseHeaders: Record<string, string> = {};
    openaiRes.headers.forEach((v, k) => { responseHeaders[k] = v; });

    console.info("[voice/sdp] response ←", {
      status: openaiRes.status,
      statusText: openaiRes.statusText,
      headers: responseHeaders,
      body_bytes: rawBody.length,
      body_preview: rawBody.slice(0, 500),
      latency_ms: latencyMs,
    });

    if (!openaiRes.ok) {
      return NextResponse.json(
        {
          error: "sdp_exchange_failed",
          openai_status: openaiRes.status,
          openai_status_text: openaiRes.statusText,
          openai_headers: responseHeaders,
          openai_body: rawBody,          // FULL body — never truncated
          model: REALTIME_CONFIG.model,
          endpoint: openaiUrl,
          key_prefix: ephemeral_key.slice(0, 8) + "…",
          key_length: ephemeral_key.length,
          sdp_bytes: sdp_offer.length,
        },
        { status: 502 },
      );
    }

    if (!rawBody.trim()) {
      return NextResponse.json(
        { error: "empty_sdp_answer", openai_status: openaiRes.status },
        { status: 502 },
      );
    }

    return NextResponse.json({ sdp_answer: rawBody });

  } catch (err) {
    const serialized = serializeException(err);
    console.error(`[voice/sdp] UNHANDLED at phase="${phase}":`, serialized);
    return NextResponse.json(
      { error: "internal_server_error", phase, latency_ms: Date.now() - t0, ...serialized },
      { status: 500 },
    );
  }
}
