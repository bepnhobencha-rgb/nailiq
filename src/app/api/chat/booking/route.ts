import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/shared/lib/supabase/server";
import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";

let anthropicClient: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: key });
  return anthropicClient;
}

const DAY_MAP: [string, string][] = [
  ["Monday", "mon"],
  ["Tuesday", "tue"],
  ["Wednesday", "wed"],
  ["Thursday", "thu"],
  ["Friday", "fri"],
  ["Saturday", "sat"],
  ["Sunday", "sun"],
];

function formatHours(openingHoursRaw: unknown): string {
  try {
    const parsed = parseOpeningHours(openingHoursRaw);
    if (!parsed) return "Hours not available";
    return DAY_MAP.map(([name, key]) => {
      const h = parsed[key as keyof typeof parsed];
      if (h.closed) return `${name}: Closed`;
      return `${name}: ${h.open} – ${h.close}`;
    }).join("\n");
  } catch {
    return "Hours not available";
  }
}

export async function POST(req: NextRequest) {
  const { salonId, messages } = (await req.json()) as {
    salonId: string;
    messages: { role: "user" | "assistant"; content: string }[];
  };

  if (!salonId || !Array.isArray(messages) || messages.length === 0) {
    return new Response("Bad request", { status: 400 });
  }

  // Fetch salon context
  const db = await createClient();
  const { data: salon } = await db
    .from("salons")
    .select("name, description, address, timezone, salon_phone, opening_hours")
    .eq("id", salonId)
    .maybeSingle();

  // Match the public booking page's service loader: the `services` table
  // has no `is_active` column (soft-delete uses `deleted_at`), and no
  // `currency` column. The previous query (.eq("is_active", true) + select
  // currency) errored silently, so the AI never received the service list
  // and deflected every pricing question to "call the salon".
  const { data: services } = await db
    .from("services")
    .select("name, duration_minutes, buffer_minutes, price_cents")
    .eq("salon_id", salonId)
    .is("deleted_at", null)
    .order("name", { ascending: true })
    .limit(30);

  const salonName = salon?.name ?? "this salon";
  const hoursText = formatHours(salon?.opening_hours);
  const serviceList = (services ?? [])
    .map((s) => {
      const price = s.price_cents ? `$${(s.price_cents / 100).toFixed(0)}` : "";
      // Match the booking page, which shows service time + buffer (totalMinutes).
      const mins = (Number(s.duration_minutes) || 0) + (Number(s.buffer_minutes) || 0);
      return `- ${s.name}${mins ? ` (${mins} min)` : ""}${price ? ` — ${price}` : ""}`;
    })
    .join("\n");

  const systemPrompt = `You are a friendly booking assistant for ${salonName}, a nail salon. Help customers with questions about services, pricing, hours, and availability. Be concise and warm.

Salon: ${salonName}
${salon?.address ? `Address: ${salon.address}` : ""}
${salon?.description ? `About: ${salon.description}` : ""}
${salon?.salon_phone ? `Phone: ${salon.salon_phone}` : ""}

Opening Hours:
${hoursText}

Services:
${serviceList || "Contact the salon for service details."}

Guidelines:
- Always reply in the same language the customer writes in (Vietnamese or English)
- For booking, direct customers to use the booking form on this page
- Keep answers short (2-3 sentences max unless listing services)
- If unsure, suggest calling the salon`;

  // Sanitize: last 10 messages, user/assistant only, trim content
  const safeMessages = messages
    .slice(-10)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 500) }));

  const ai = getClient();
  if (!ai) return new Response("AI unavailable", { status: 503 });

  const stream = await ai.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 256,
    system: systemPrompt,
    messages: safeMessages,
    stream: true,
  });

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          if (
            chunk.type === "content_block_delta" &&
            chunk.delta.type === "text_delta"
          ) {
            controller.enqueue(encoder.encode(chunk.delta.text));
          }
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(readable, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-accel-buffering": "no",
      "cache-control": "no-store",
    },
  });
}
