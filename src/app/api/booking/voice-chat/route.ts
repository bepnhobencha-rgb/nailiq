import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import type { VoiceChatMessage, VoiceChatResponse } from "@/shared/types/booking";
export type { VoiceChatMessage, VoiceChatResponse } from "@/shared/types/booking";

const client = new Anthropic();

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "no_key" }, { status: 503 });
  }

  const body = (await req.json()) as {
    messages: VoiceChatMessage[];
    services: { id: string; name: string }[];
    staff: { id: string; name: string }[];
    language?: "en" | "vi";
  };

  const { messages, services, staff, language = "en" } = body;

  const serviceList = services.map((s) => `"${s.name}" (id:${s.id})`).join(", ");
  const staffList = staff.map((s) => `"${s.name}" (id:${s.id})`).join(", ");
  const lang = language === "vi" ? "Vietnamese" : "English";

  const system = `You are a polished, professional nail salon receptionist taking a voice booking. Sound like a real human receptionist — warm, clear, and confident. Not robotic, not overly peppy.

Services: ${serviceList}
Staff: ${staffList}

Collect ALL of the following in order, one question at a time:
1. service (required)
2. date (required)
3. time (required)
4. client's name (required) — ask after time is confirmed
5. client's phone number (required) — ask last, tell them to say it clearly

Never ask for staff unless the customer volunteers it.

Respond ONLY with JSON, no markdown:
{"reply":"spoken response in ${lang}","fill":{"serviceId":null,"serviceName":null,"staffId":null,"staffName":null,"dateHint":null,"timeHint":null,"clientName":null,"clientPhone":null},"done":false}

Tone guidelines:
- Professional yet warm: "Of course!", "Lovely choice.", "Let me get that set up for you."
- Clear and concise — this is spoken aloud, 1-2 short sentences max
- Confirm what you heard before asking next: "A pedicure, wonderful. What day were you thinking?"
- When asking for phone: "Perfect! And what's the best phone number to reach you?" / "Cho em xin số điện thoại của bạn ạ?"
- When done: confirm everything warmly — "You're all set! I've got your [service] booked for [date] at [time]. Confirming your booking now!" / "Tuyệt vời! Em đã đặt [service] vào [date] lúc [time] cho bạn rồi ạ. Đang xác nhận…"

Rules:
- "fill" reflects ALL fields known from the full conversation
- done:true ONLY when service + date + time + clientName + clientPhone are ALL confirmed
- Only use IDs from the provided lists; null for anything unknown`;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system,
      messages,
    });

    const text =
      response.content[0]?.type === "text" ? response.content[0].text.trim() : "";

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("no_json");

    const parsed = JSON.parse(jsonMatch[0]) as VoiceChatResponse;

    // Reject hallucinated IDs
    const validServiceIds = new Set(services.map((s) => s.id));
    const validStaffIds = new Set(staff.map((s) => s.id));
    if (parsed.fill.serviceId && !validServiceIds.has(parsed.fill.serviceId)) {
      parsed.fill.serviceId = null;
      parsed.fill.serviceName = null;
    }
    if (parsed.fill.staffId && !validStaffIds.has(parsed.fill.staffId)) {
      parsed.fill.staffId = null;
      parsed.fill.staffName = null;
    }

    return NextResponse.json(parsed);
  } catch {
    const fallback =
      language === "vi"
        ? "Xin lỗi, tôi chưa hiểu. Bạn nói lại được không?"
        : "Sorry, I didn't catch that. Could you say that again?";
    return NextResponse.json({
      reply: fallback,
      fill: {
        serviceId: null,
        serviceName: null,
        staffId: null,
        staffName: null,
        dateHint: null,
        timeHint: null,
        clientName: null,
        clientPhone: null,
      },
      done: false,
    });
  }
}
