/**
 * SDP proxy — receives the client's SDP offer + ephemeral key,
 * forwards to OpenAI using Node.js native https.request (bypasses all
 * fetch wrappers including Next.js cache patch and Sentry tracing).
 *
 * Auth: ephemeral key minted by /api/voice/session.  Main key never used here.
 */

import https from "https";
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

/** Low-level HTTPS POST — sends EXACTLY the headers provided, nothing else. */
function httpsPost(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; headers: Record<string, string | string[]>; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(body, "utf8").toString(),
        },
      },
      (res) => {
        const respHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (v !== undefined) respHeaders[k] = v;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: respHeaders,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
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

    // Only these two headers — nothing else.
    const outgoingHeaders: Record<string, string> = {
      "Authorization": `Bearer ${ephemeral_key}`,
      "Content-Type": "application/sdp",
    };

    console.info("[voice/sdp] https.request →", {
      url: openaiUrl,
      header_keys: Object.keys(outgoingHeaders),
      key_prefix: ephemeral_key.slice(0, 8) + "…",
      key_length: ephemeral_key.length,
      sdp_bytes: sdp_offer.length,
      sdp_preview: sdp_offer.slice(0, 120).replace(/\r\n/g, "↵"),
    });

    let result: Awaited<ReturnType<typeof httpsPost>>;
    try {
      result = await httpsPost(openaiUrl, outgoingHeaders, sdp_offer);
    } catch (netErr) {
      const serialized = serializeException(netErr);
      console.error("[voice/sdp] network error:", serialized);
      return NextResponse.json(
        { error: "sdp_network_error", openai_url: openaiUrl, ...serialized },
        { status: 502 },
      );
    }

    const latencyMs = Date.now() - t0;
    console.info("[voice/sdp] response ←", {
      status: result.status,
      header_keys: Object.keys(result.headers),
      location: result.headers["location"] ?? null,
      content_type: result.headers["content-type"] ?? null,
      body_bytes: result.body.length,
      body_preview: result.body.slice(0, 400),
      latency_ms: latencyMs,
    });

    if (result.status < 200 || result.status >= 300) {
      return NextResponse.json(
        {
          error: "sdp_exchange_failed",
          openai_status: result.status,
          openai_headers: result.headers,
          openai_body: result.body,
          model: REALTIME_CONFIG.model,
          endpoint: openaiUrl,
          key_prefix: ephemeral_key.slice(0, 8) + "…",
          key_length: ephemeral_key.length,
          sdp_bytes: sdp_offer.length,
        },
        { status: 502 },
      );
    }

    if (!result.body.trim()) {
      return NextResponse.json(
        { error: "empty_sdp_answer", openai_status: result.status },
        { status: 502 },
      );
    }

    return NextResponse.json({ sdp_answer: result.body });

  } catch (err) {
    const serialized = serializeException(err);
    console.error(`[voice/sdp] UNHANDLED at phase="${phase}":`, serialized);
    return NextResponse.json(
      { error: "internal_server_error", phase, latency_ms: Date.now() - t0, ...serialized },
      { status: 500 },
    );
  }
}
