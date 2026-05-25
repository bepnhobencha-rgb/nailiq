import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "no_key" });

  const tests: Record<string, unknown> = {};

  // Test different model names on /v1/realtime/sessions
  const models = [
    "gpt-4o-realtime-preview",
    "gpt-4o-mini-realtime-preview",
    "gpt-4o-realtime-preview-2025-06-03",
  ];

  for (const model of models) {
    const r = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, modalities: ["audio", "text"] }),
    });
    const body = await r.json();
    tests[model] = { status: r.status, error: (body as { error?: { code?: string } }).error?.code ?? "ok" };
  }

  // Check available models
  const listRes = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const modelList = await listRes.json() as { data?: { id: string }[] };
  const realtimeModels = (modelList.data ?? []).filter(m => m.id.includes("realtime")).map(m => m.id);

  return NextResponse.json({ tests, available_realtime_models: realtimeModels });
}
