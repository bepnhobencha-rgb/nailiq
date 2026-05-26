import https from "https";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const MODEL    = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2025-08-28";
const SDP_HOST = "api.openai.com";
const SDP_PATH = `/v1/realtime?model=${MODEL}`;

function rawPost(
  host: string, path: string,
  reqHeaders: Record<string, string>,
  body: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host, port: 443, path, method: "POST",
        headers: { ...reqHeaders, "Content-Length": String(Buffer.byteLength(body, "utf8")) },
      },
      (res) => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          h[k] = Array.isArray(v) ? v.join(", ") : (v ?? "");
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
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "no_openai_key" }, { status: 503 });

  let sdp_offer: string;
  try {
    ({ sdp_offer } = await req.json() as { sdp_offer: string });
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!sdp_offer?.trim()) return NextResponse.json({ error: "missing_sdp_offer" }, { status: 400 });

  // Exactly two headers — nothing else.
  const outgoing = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type":  "application/sdp",
  };

  console.info("[voice/sdp] →", {
    url: `https://${SDP_HOST}${SDP_PATH}`,
    header_keys: Object.keys(outgoing),
    key_prefix: apiKey.slice(0, 8) + "…",
    sdp_bytes: sdp_offer.length,
    sdp_preview: sdp_offer.slice(0, 200).replace(/\r\n/g, "↵"),
  });

  let result: Awaited<ReturnType<typeof rawPost>>;
  try {
    result = await rawPost(SDP_HOST, SDP_PATH, outgoing, sdp_offer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[voice/sdp] network error:", msg);
    return NextResponse.json({ error: "network_error", detail: msg }, { status: 502 });
  }

  console.info("[voice/sdp] ←", {
    status: result.status,
    content_type: result.headers["content-type"],
    location: result.headers["location"],
    body_bytes: result.body.length,
    body_preview: result.body.slice(0, 300),
  });

  if (result.status < 200 || result.status >= 300) {
    return NextResponse.json({
      error: "sdp_exchange_failed",
      openai_status:  result.status,
      openai_headers: result.headers,
      openai_body:    result.body,
      model:          MODEL,
    }, { status: 502 });
  }

  if (!result.body.trim()) {
    return NextResponse.json({ error: "empty_sdp_answer", openai_status: result.status }, { status: 502 });
  }

  return NextResponse.json({ sdp_answer: result.body });
}
