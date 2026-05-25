import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Temporary debug endpoint — DELETE before production
export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "no_key" }, { status: 503 });

  const body = (await req.json()) as object;

  const res = await fetch("https://api.openai.com/v1/realtime/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  return NextResponse.json({ status: res.status, body: text });
}
