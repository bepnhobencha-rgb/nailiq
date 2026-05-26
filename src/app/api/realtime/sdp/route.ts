// Use Node.js built-in http2 module directly.
// Reason: https.request uses HTTP/1.1. OpenAI's GA SDP endpoint appears
// to require HTTP/2. http2 is also unaffected by Next.js ISR patching
// or Sentry's withSentryConfig global fetch hook (sentry-trace, baggage).
import http2 from "node:http2";
import { NextRequest, NextResponse } from "next/server";

export const runtime    = "nodejs";
export const maxDuration = 30;

const MODEL    = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2025-08-28";
const ENDPOINT = `https://api.openai.com/v1/realtime?model=${MODEL}`;
const HOST     = "https://api.openai.com";
const PATH     = `/v1/realtime?model=${MODEL}`;

function http2Post(
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(HOST);
    client.on("error", reject);

    const outHeaders: http2.OutgoingHttpHeaders = {
      ":method":  "POST",
      ":path":    path,
      ":scheme":  "https",
      ":authority": "api.openai.com",
      ...headers,
      "content-length": String(Buffer.byteLength(body, "utf8")),
    };

    const req = client.request(outHeaders);

    req.on("error", (err) => { client.close(); reject(err); });

    const chunks: Buffer[] = [];
    let status = 0;
    const resHeaders: Record<string, string> = {};

    req.on("response", (h) => {
      status = Number(h[":status"] ?? 0);
      for (const [k, v] of Object.entries(h)) {
        if (!k.startsWith(":")) {
          resHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
        }
      }
    });

    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      client.close();
      resolve({ status, headers: resHeaders, body: Buffer.concat(chunks).toString("utf8") });
    });

    req.write(body, "utf8");
    req.end();
  });
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("[realtime/sdp] OPENAI_API_KEY not set");
    return NextResponse.json({ error: "no_openai_key" }, { status: 503 });
  }

  let sdp_offer: string;
  try {
    ({ sdp_offer } = await req.json() as { sdp_offer: string });
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!sdp_offer?.trim()) return NextResponse.json({ error: "missing_sdp_offer" }, { status: 400 });

  // Exactly two headers. Nothing else.
  const headers = {
    "authorization": `Bearer ${apiKey}`,
    "content-type":  "application/sdp",
  };

  console.log("[realtime/sdp] → URL:", ENDPOINT);
  console.log("[realtime/sdp] → headers:", {
    authorization: `Bearer ${apiKey.slice(0, 8)}…`,
    "content-type": headers["content-type"],
  });
  console.log("[realtime/sdp] → typeof body:", typeof sdp_offer);
  console.log("[realtime/sdp] → body (first 100):", sdp_offer.slice(0, 100));

  let result: Awaited<ReturnType<typeof http2Post>>;
  try {
    result = await http2Post(PATH, headers, sdp_offer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[realtime/sdp] network_error:", msg);
    return NextResponse.json({ error: "network_error", detail: msg }, { status: 502 });
  }

  console.log("[realtime/sdp] ← status:", result.status);
  console.log("[realtime/sdp] ← content-type:", result.headers["content-type"]);
  console.log("[realtime/sdp] ← location:", result.headers["location"]);
  console.log("[realtime/sdp] ← body (first 200):", result.body.slice(0, 200));

  if (result.status < 200 || result.status >= 300) {
    const payload = {
      error:          "sdp_exchange_failed",
      openai_status:  result.status,
      openai_headers: result.headers,
      openai_body:    result.body,
      model:          MODEL,
      url:            ENDPOINT,
    };
    console.error("[realtime/sdp] openai error:", payload);
    return NextResponse.json(payload, { status: 502 });
  }

  if (!result.body.trim()) {
    return NextResponse.json({ error: "empty_sdp_answer", openai_status: result.status }, { status: 502 });
  }

  console.log("[realtime/sdp] ✓ sdp_answer bytes:", result.body.length);
  return NextResponse.json({ sdp_answer: result.body });
}
