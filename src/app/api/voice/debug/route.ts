import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "no_key" });

  const tests: Record<string, unknown> = {};
  const candidates = ["gpt-realtime", "gpt-realtime-2025-08-28", "gpt-realtime-mini"];

  for (const model of candidates) {
    const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, modalities: ["audio", "text"], voice: "shimmer" }),
    });
    const body = await r.json() as { error?: { code?: string }; id?: string };
    tests[model] = { status: r.status, error: body.error?.code, session_id: body.id };
  }

  return NextResponse.json({ tests });
}
