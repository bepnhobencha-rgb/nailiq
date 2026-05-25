import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Temporary — delete after migration confirmed
export async function GET() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "no_key" });

  const results: Record<string, unknown> = {};

  const tryPost = async (url: string, body: object, id: string) => {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 200); }
      results[id] = { status: r.status, body: parsed };
    } catch (e) {
      results[id] = { error: String(e) };
    }
  };

  // 1. Old session endpoint with new models
  await tryPost("https://api.openai.com/v1/realtime/sessions",
    { model: "gpt-realtime", modalities: ["audio", "text"] },
    "sessions_gpt-realtime");

  await tryPost("https://api.openai.com/v1/realtime/sessions",
    { model: "gpt-realtime-2025-08-28", modalities: ["audio", "text"] },
    "sessions_gpt-realtime-2025-08-28");

  // 2. Possible new endpoints
  for (const path of ["/v1/realtime/tokens", "/v1/realtime/auth", "/v1/realtime/connections"]) {
    await tryPost(`https://api.openai.com${path}`,
      { model: "gpt-realtime", modalities: ["audio", "text"] },
      `probe${path.replace(/\//g, "_")}`);
  }

  // 3. GA direct SDP endpoint test (send dummy SDP to detect 405 vs 400 vs 200)
  try {
    const r = await fetch("https://api.openai.com/v1/realtime?model=gpt-realtime", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/sdp" },
      body: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
    });
    results["sdp_direct"] = { status: r.status, body: (await r.text()).slice(0, 300) };
  } catch (e) {
    results["sdp_direct"] = { error: String(e) };
  }

  return NextResponse.json(results, { status: 200 });
}
