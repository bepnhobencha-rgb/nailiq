import https from "https";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const REALTIME_MODEL   = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2025-08-28";
const OPENAI_SDP_HOST  = "api.openai.com";
const OPENAI_SDP_PATH  = `/v1/realtime?model=${REALTIME_MODEL}`;

/** Raw HTTPS POST — bypasses all fetch wrappers. Sends exactly the headers provided. */
function rawPost(
  host: string, path: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host, port: 443, path, method: "POST",
        headers: { ...headers, "Content-Length": String(Buffer.byteLength(body, "utf8")) },
      },
      (res) => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") h[k] = v;
          else if (Array.isArray(v))  h[k] = v.join(", ");
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: h, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export async function POST(req: NextRequest) {
  let ephemeral_key: string, sdp_offer: string;
  try {
    ({ ephemeral_key, sdp_offer } = await req.json() as { ephemeral_key: string; sdp_offer: string });
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!ephemeral_key || !sdp_offer) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }

  // Only these two headers. Nothing else.
  const headers = {
    "Authorization": `Bearer ${ephemeral_key}`,
    "Content-Type":  "application/sdp",
  };

  console.info("[voice/sdp] →", {
    host: OPENAI_SDP_HOST, path: OPENAI_SDP_PATH,
    header_keys: Object.keys(headers),
    key_prefix: ephemeral_key.slice(0, 8) + "…",
    sdp_bytes: sdp_offer.length,
  });

  let result: Awaited<ReturnType<typeof rawPost>>;
  try {
    result = await rawPost(OPENAI_SDP_HOST, OPENAI_SDP_PATH, headers, sdp_offer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[voice/sdp] network error:", msg);
    return NextResponse.json({ error: "network_error", detail: msg }, { status: 502 });
  }

  console.info("[voice/sdp] ←", {
    status: result.status,
    content_type: result.headers["content-type"],
    location: result.headers["location"],
    body_preview: result.body.slice(0, 300),
  });

  if (result.status < 200 || result.status >= 300) {
    return NextResponse.json({
      error:          "sdp_exchange_failed",
      openai_status:  result.status,
      openai_headers: result.headers,
      openai_body:    result.body,
      model:          REALTIME_MODEL,
    }, { status: 502 });
  }

  if (!result.body.trim()) {
    return NextResponse.json({ error: "empty_sdp_answer", openai_status: result.status }, { status: 502 });
  }

  return NextResponse.json({ sdp_answer: result.body });
}
