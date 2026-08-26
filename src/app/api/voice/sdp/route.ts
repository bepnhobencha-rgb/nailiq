import { NextRequest, NextResponse } from "next/server";
import { VOICE_MODEL, OPENAI_SDP_URL } from "@/shared/voiceai/config";
import { clientIp } from "@/shared/lib/inAppRateLimit";
import { consumeDurableRateLimitBuckets } from "@/shared/security/publicServerActionRateLimit";

export const runtime     = "nodejs";
export const maxDuration = 30;

/**
 * Proxies the WebRTC SDP offer to OpenAI using the ephemeral key
 * obtained from /api/voice/session. Returns the SDP answer.
 */
export async function POST(req: NextRequest) {
  const rate = await consumeDurableRateLimitBuckets("voice-sdp", [
    { name: "ip-five-minute", material: [clientIp(req)], limit: 60, windowSeconds: 300 },
  ]);
  if (rate !== "allowed") {
    return NextResponse.json(
      { error: rate === "limited" ? "rate_limited" : "rate_limit_unavailable" },
      { status: rate === "limited" ? 429 : 503, headers: { "Retry-After": rate === "limited" ? "300" : "30" } },
    );
  }
  let sdp_offer: string, ephemeralKey: string;
  try {
    ({ sdp_offer, ephemeralKey } = await req.json() as { sdp_offer: string; ephemeralKey: string });
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!sdp_offer?.trim())    return NextResponse.json({ error: "missing_sdp_offer" }, { status: 400 });
  if (!ephemeralKey?.trim()) return NextResponse.json({ error: "missing_ephemeral_key" }, { status: 400 });

  const url = `${OPENAI_SDP_URL}?model=${encodeURIComponent(VOICE_MODEL)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${ephemeralKey}`,
        "Content-Type":  "application/sdp",
      },
      body: sdp_offer,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "network_error_sdp", detail: msg }, { status: 502 });
  }

  const body = await res.text();
  if (!res.ok || !body.trim()) {
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => { resHeaders[k] = v; });
    console.error("[voice/sdp] exchange failed", { status: res.status, body, url, model: VOICE_MODEL });
    return NextResponse.json(
      { error: "sdp_exchange_failed", openai_status: res.status, openai_body: body, openai_headers: resHeaders, model: VOICE_MODEL, url },
      { status: 502 },
    );
  }

  return NextResponse.json({ sdp_answer: body });
}
