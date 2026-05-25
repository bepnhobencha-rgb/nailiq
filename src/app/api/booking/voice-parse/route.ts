/**
 * POST /api/booking/voice-parse
 * Extracts booking intent (service, staff, date/time hints) from a voice transcript.
 * Powered by Claude Haiku for low latency.
 */

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!client) client = new Anthropic({ apiKey: key });
  return client;
}

type ServiceItem = { id: string; name: string };
type StaffItem = { id: string; name: string };

export type VoiceParseResult = {
  serviceId: string | null;
  serviceName: string | null;
  staffId: string | null;
  staffName: string | null;
  dateHint: string | null;
  timeHint: string | null;
  clientName: string | null;
  clientPhone: string | null;
};

export async function POST(req: NextRequest) {
  const ai = getClient();
  if (!ai) {
    return NextResponse.json({ error: "AI unavailable" }, { status: 503 });
  }

  let transcript: string;
  let services: ServiceItem[];
  let staff: StaffItem[];

  try {
    const body = (await req.json()) as {
      transcript: string;
      services: ServiceItem[];
      staff: StaffItem[];
    };
    transcript = String(body.transcript ?? "").trim().slice(0, 500);
    services = Array.isArray(body.services) ? body.services.slice(0, 50) : [];
    staff = Array.isArray(body.staff) ? body.staff.slice(0, 30) : [];
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  if (!transcript) {
    return NextResponse.json({ error: "Empty transcript" }, { status: 400 });
  }

  const serviceList = services
    .map((s) => `- id:${s.id} name:"${s.name}"`)
    .join("\n");
  const staffList = staff
    .map((s) => `- id:${s.id} name:"${s.name}"`)
    .join("\n");

  const prompt = `You are a booking intent extractor for a nail salon. Given a voice transcript (may be English or Vietnamese), extract booking details.

Available services:
${serviceList || "(none)"}

Available staff:
${staffList || "(none)"}

Voice transcript: "${transcript}"

Return ONLY a JSON object with these fields (null if not mentioned or not confidently matched):
{
  "serviceId": string | null,   // exact id from services list, fuzzy-match by name
  "serviceName": string | null, // matched service name for display
  "staffId": string | null,     // exact id from staff list, fuzzy-match by name
  "staffName": string | null,   // matched staff name for display
  "dateHint": string | null,    // e.g. "tomorrow", "next Friday", "thứ 6 tới"
  "timeHint": string | null,    // e.g. "2pm", "morning", "14:00", "buổi chiều"
  "clientName": string | null,  // customer's own name if stated
  "clientPhone": string | null  // phone number if stated
}

Rules:
- Only match serviceId if you're confident (>80%) it maps to a service in the list
- Only match staffId if the name closely matches a staff member
- Prefer null over a wrong guess
- Return raw JSON only, no markdown`;

  try {
    const response = await ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    });

    const rawText =
      response.content[0]?.type === "text" ? response.content[0].text : "";

    // Extract JSON from response (handle potential markdown fencing)
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json<VoiceParseResult>({
        serviceId: null,
        serviceName: null,
        staffId: null,
        staffName: null,
        dateHint: null,
        timeHint: null,
        clientName: null,
        clientPhone: null,
      });
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<VoiceParseResult>;

    // Validate: ensure returned IDs actually exist in our lists
    const validServiceId =
      parsed.serviceId &&
      services.some((s) => s.id === parsed.serviceId)
        ? parsed.serviceId
        : null;
    const validStaffId =
      parsed.staffId && staff.some((s) => s.id === parsed.staffId)
        ? parsed.staffId
        : null;

    const result: VoiceParseResult = {
      serviceId: validServiceId,
      serviceName: validServiceId
        ? (services.find((s) => s.id === validServiceId)?.name ?? null)
        : null,
      staffId: validStaffId,
      staffName: validStaffId
        ? (staff.find((s) => s.id === validStaffId)?.name ?? null)
        : null,
      dateHint: typeof parsed.dateHint === "string" ? parsed.dateHint : null,
      timeHint: typeof parsed.timeHint === "string" ? parsed.timeHint : null,
      clientName:
        typeof parsed.clientName === "string" ? parsed.clientName : null,
      clientPhone:
        typeof parsed.clientPhone === "string" ? parsed.clientPhone : null,
    };

    return NextResponse.json(result);
  } catch (e) {
    console.error("[voice-parse] Claude error", e);
    return NextResponse.json({ error: "Parse failed" }, { status: 500 });
  }
}
