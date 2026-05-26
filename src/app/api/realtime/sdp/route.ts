// OpenAI's GA SDP endpoint (/v1/realtime) rejects project API keys (sk-proj-...).
// It only accepts short-lived ephemeral tokens (ek_...) created via
// /v1/realtime/client_secrets. Using a project key directly is what OpenAI
// calls "beta_api_shape_disabled" — even when the URL and headers are correct.
//
// Two-step flow handled entirely server-side:
//   1. POST /v1/realtime/client_secrets  (sk-proj-...) → { value: "ek_..." }
//   2. POST /v1/realtime?model=...       (ek-...)      + raw SDP body → SDP answer
//
// Client still sends only { sdp_offer }. No ephemeral key ever touches the browser.
import http2 from "node:http2";
import { NextRequest, NextResponse } from "next/server";

export const runtime    = "nodejs";
export const maxDuration = 30;

const MODEL    = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2025-08-28";
const OAI_HOST = "https://api.openai.com";

// ── HTTP/2 POST helper ─────────────────────────────────────────────────────────
// Uses node:http2 to bypass Next.js ISR fetch patching and Sentry's global
// fetch hook (which injects sentry-trace + baggage headers).

function h2post(
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(OAI_HOST);
    client.on("error", (e) => { try { client.close(); } catch { /* */ } reject(e); });

    const reqHeaders: http2.OutgoingHttpHeaders = {
      ":method":    "POST",
      ":path":      path,
      ":scheme":    "https",
      ":authority": "api.openai.com",
      ...headers,
      "content-length": String(Buffer.byteLength(body, "utf8")),
    };

    const req = client.request(reqHeaders);
    req.on("error", (e) => { try { client.close(); } catch { /* */ } reject(e); });

    const chunks: Buffer[] = [];
    let status = 0;
    const resHeaders: Record<string, string> = {};

    req.on("response", (h) => {
      status = Number(h[":status"] ?? 0);
      for (const [k, v] of Object.entries(h)) {
        if (!k.startsWith(":")) resHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
      }
    });

    req.on("data",  (c: Buffer) => chunks.push(c));
    req.on("end",   () => { client.close(); resolve({ status, headers: resHeaders, body: Buffer.concat(chunks).toString("utf8") }); });

    req.write(body, "utf8");
    req.end();
  });
}

// ── Step 1: mint ephemeral token ───────────────────────────────────────────────

async function mintEphemeralKey(apiKey: string): Promise<string> {
  // Model goes in the query string — same pattern as the SDP endpoint.
  // The request body must be empty; sending { model } causes "unknown_parameter".
  const path = `/v1/realtime/client_secrets?model=${encodeURIComponent(MODEL)}`;
  const body = "";

  console.log("[realtime/sdp] minting ephemeral key →", { path, model: MODEL });

  const result = await h2post(path, {
    "authorization": `Bearer ${apiKey}`,
    "content-type":  "application/json",
  }, body);

  console.log("[realtime/sdp] client_secrets ←", {
    status:       result.status,
    body_preview: result.body.slice(0, 200),
  });

  if (result.status < 200 || result.status >= 300) {
    throw Object.assign(
      new Error("ephemeral_key_failed"),
      { _detail: { status: result.status, body: result.body } },
    );
  }

  const data = JSON.parse(result.body) as { value?: string };
  if (!data.value) {
    throw Object.assign(
      new Error("ephemeral_key_missing"),
      { _detail: { response: data } },
    );
  }

  console.log("[realtime/sdp] ephemeral key:", data.value.slice(0, 8) + "…");
  return data.value;
}

// ── Route handler ──────────────────────────────────────────────────────────────

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

  // ── Step 1: ephemeral key ────────────────────────────────────────────────────
  let ephemeralKey: string;
  try {
    ephemeralKey = await mintEphemeralKey(apiKey);
  } catch (err) {
    const detail = (err as Record<string, unknown>)._detail ?? null;
    const msg    = err instanceof Error ? err.message : String(err);
    console.error("[realtime/sdp] ephemeral key error:", { msg, detail });
    return NextResponse.json({ error: msg, detail }, { status: 502 });
  }

  // ── Step 2: SDP exchange with ephemeral key ──────────────────────────────────
  const sdpPath = `/v1/realtime?model=${MODEL}`;
  const sdpUrl  = `${OAI_HOST}${sdpPath}`;

  console.log("[realtime/sdp] SDP exchange →", sdpUrl);
  console.log("[realtime/sdp] authorization: Bearer", ephemeralKey.slice(0, 8) + "…");
  console.log("[realtime/sdp] typeof body:", typeof sdp_offer);
  console.log("[realtime/sdp] body (first 100):", sdp_offer.slice(0, 100));

  let sdpResult: Awaited<ReturnType<typeof h2post>>;
  try {
    sdpResult = await h2post(sdpPath, {
      "authorization": `Bearer ${ephemeralKey}`,
      "content-type":  "application/sdp",
    }, sdp_offer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[realtime/sdp] SDP network error:", msg);
    return NextResponse.json({ error: "network_error", detail: msg }, { status: 502 });
  }

  console.log("[realtime/sdp] SDP ←", {
    status:       sdpResult.status,
    content_type: sdpResult.headers["content-type"],
    location:     sdpResult.headers["location"],
    body_bytes:   sdpResult.body.length,
    body_preview: sdpResult.body.slice(0, 200),
  });

  if (sdpResult.status < 200 || sdpResult.status >= 300) {
    const payload = {
      error:          "sdp_exchange_failed",
      openai_status:  sdpResult.status,
      openai_headers: sdpResult.headers,
      openai_body:    sdpResult.body,
      model:          MODEL,
      url:            sdpUrl,
    };
    console.error("[realtime/sdp] SDP error:", payload);
    return NextResponse.json(payload, { status: 502 });
  }

  if (!sdpResult.body.trim()) {
    return NextResponse.json({ error: "empty_sdp_answer", openai_status: sdpResult.status }, { status: 502 });
  }

  console.log("[realtime/sdp] ✓ sdp_answer bytes:", sdpResult.body.length);
  return NextResponse.json({ sdp_answer: sdpResult.body });
}
