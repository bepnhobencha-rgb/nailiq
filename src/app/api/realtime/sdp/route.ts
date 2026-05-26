import { NextRequest, NextResponse } from "next/server";

export const runtime    = "nodejs";
export const maxDuration = 30;

const MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-4o-realtime-preview";

export async function POST(req: NextRequest) {
  // ── SENTINEL — confirms this file is the live route ───────────────────────
  console.log("REALTIME_V2_SDP_ROUTE_ACTIVE", { model: MODEL, ts: new Date().toISOString() });

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

  // ── Step 1: mint ephemeral key ────────────────────────────────────────────
  // model in query string — /v1/realtime/client_secrets rejects it in body
  const CLIENT_SECRETS_URL = `https://api.openai.com/v1/realtime/client_secrets?model=${encodeURIComponent(MODEL)}`;
  const clientSecretsHeaders = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type":  "application/json",
  };

  console.log("[realtime/sdp] STEP1 client_secrets →");
  console.log("  URL:", CLIENT_SECRETS_URL);
  console.log("  headers:", { ...clientSecretsHeaders, Authorization: `Bearer ${apiKey.slice(0, 8)}…` });

  let csRes: Response;
  try {
    csRes = await fetch(CLIENT_SECRETS_URL, {
      method:  "POST",
      headers: clientSecretsHeaders,
      body:    "",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[realtime/sdp] client_secrets network error:", msg);
    return NextResponse.json({ error: "network_error_client_secrets", detail: msg }, { status: 502 });
  }

  const csBody = await csRes.text();
  console.log("[realtime/sdp] STEP1 client_secrets ←");
  console.log("  status:", csRes.status);
  console.log("  body:", csBody);

  if (!csRes.ok) {
    return NextResponse.json({ error: "ephemeral_key_failed", openai_status: csRes.status, openai_body: csBody }, { status: 502 });
  }

  let ephemeralKey: string;
  try {
    const csData = JSON.parse(csBody) as { value?: string; expires_at?: number; session?: unknown };
    console.log("[realtime/sdp] STEP1 parsed:", { key_prefix: csData.value?.slice(0, 8) + "…", expires_at: csData.expires_at, session: csData.session });
    if (!csData.value) throw new Error("no value field");
    ephemeralKey = csData.value;
  } catch (err) {
    return NextResponse.json({ error: "ephemeral_key_parse_failed", raw: csBody, detail: String(err) }, { status: 502 });
  }

  // ── Step 2: SDP exchange ──────────────────────────────────────────────────
  const SDP_URL = `https://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;
  const sdpHeaders = {
    "Authorization": `Bearer ${ephemeralKey}`,
    "Content-Type":  "application/sdp",
  };

  // FINAL request details — exactly what will be sent
  console.log("FINAL_FETCH_URL", SDP_URL);
  console.log("FINAL_FETCH_HEADERS", { ...sdpHeaders, Authorization: `Bearer ${ephemeralKey.slice(0, 8)}…` });
  console.log("FINAL_FETCH_BODY_TYPE", typeof sdp_offer);
  console.log("FINAL_FETCH_BODY_FIRST_100", sdp_offer.slice(0, 100));
  console.log("FINAL_FETCH_BODY_BYTES", sdp_offer.length);

  let sdpRes: Response;
  try {
    sdpRes = await fetch(SDP_URL, {
      method:  "POST",
      headers: sdpHeaders,
      body:    sdp_offer,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[realtime/sdp] SDP network error:", msg);
    return NextResponse.json({ error: "network_error_sdp", detail: msg }, { status: 502 });
  }

  const sdpBody = await sdpRes.text();
  const sdpResHeaders: Record<string, string> = {};
  sdpRes.headers.forEach((v: string, k: string) => { sdpResHeaders[k] = v; });

  console.log("[realtime/sdp] STEP2 SDP ←");
  console.log("  status:", sdpRes.status);
  console.log("  headers:", sdpResHeaders);
  console.log("  body (first 300):", sdpBody.slice(0, 300));

  if (!sdpRes.ok) {
    const payload = {
      error:          "sdp_exchange_failed",
      openai_status:  sdpRes.status,
      openai_headers: sdpResHeaders,
      openai_body:    sdpBody,
      model:          MODEL,
      url:            SDP_URL,
    };
    console.error("[realtime/sdp] STEP2 error:", payload);
    return NextResponse.json(payload, { status: 502 });
  }

  if (!sdpBody.trim()) {
    return NextResponse.json({ error: "empty_sdp_answer", openai_status: sdpRes.status }, { status: 502 });
  }

  console.log("[realtime/sdp] ✓ sdp_answer bytes:", sdpBody.length);
  return NextResponse.json({ sdp_answer: sdpBody });
}
