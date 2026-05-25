import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Temporary endpoint — delete after confirming correct GA SDP path
export async function GET() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "no_key" });

  const results: Record<string, unknown> = {};

  // 1. Test /v1/realtime/calls with FormData (user-proposed GA endpoint)
  try {
    const form = new FormData();
    form.append("sdp", "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n");
    form.append("session", JSON.stringify({ type: "realtime", model: "gpt-realtime-2", audio: { output: { voice: "marin" } } }));

    const r = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    const text = await r.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
    results["calls_formdata"] = { status: r.status, body };
  } catch (e) {
    results["calls_formdata"] = { error: String(e) };
  }

  // 2. Test /v1/realtime/client_secrets
  try {
    const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-realtime-2" }),
    });
    const text = await r.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
    results["client_secrets"] = { status: r.status, body };
  } catch (e) {
    results["client_secrets"] = { error: String(e) };
  }

  // 3. Current impl: /v1/realtime with SDP (control group)
  try {
    const r = await fetch("https://api.openai.com/v1/realtime?model=gpt-realtime-2025-08-28", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/sdp" },
      body: "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n",
    });
    const text = await r.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 300); }
    results["sdp_direct_current"] = { status: r.status, body };
  } catch (e) {
    results["sdp_direct_current"] = { error: String(e) };
  }

  // 4. Voices check — list available voices if API exists
  try {
    const r = await fetch("https://api.openai.com/v1/realtime/voices", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    results["voices_list"] = { status: r.status };
  } catch (e) {
    results["voices_list"] = { error: String(e) };
  }

  return NextResponse.json(results);
}
