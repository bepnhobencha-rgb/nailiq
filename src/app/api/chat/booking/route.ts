import { NextRequest } from "next/server";
import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/shared/lib/supabase/server";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { parseOpeningHours } from "@/shared/dashboard/openingHoursDefaults";
import { resolveVertical } from "@/shared/verticals/registry";
import { serviceBlockMinutes } from "@/shared/booking/bookingBlock";
import { trackAnthropicMessage, trackAnthropicStream } from "@/shared/ai/usageLedger";
import { clientIp } from "@/shared/lib/inAppRateLimit";
import { loadSalonContext } from "@/shared/voiceai/loadSalonContext";
import { buildSystemPrompt } from "@/shared/voiceai/buildSystemPrompt";
import { REALTIME_TOOLS } from "@/shared/voiceai/realtimeTools";
import { executeVoiceTool } from "@/shared/voiceai/toolExecutor";
import {
  runSmsAgent,
  toAnthropicTools,
  type ContentBlock,
  type LlmComplete,
  type RealtimeToolSchema,
  type StoredTurn,
} from "@/shared/voiceai/smsAgent";
import {
  BOOKING_CHAT_AGENT_MODEL,
  BOOKING_CHAT_CHANNEL_NOTE,
  BOOKING_CHAT_MAX_HISTORY,
  BOOKING_CHAT_MAX_REPLY_TOKENS,
  BOOKING_CHAT_MAX_TOOL_TURNS,
  bookingChatToolsEnabled,
  isWebBookingToolName,
  selectWebBookingTools,
} from "@/shared/voiceai/bookingChatAgent";

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

  type TransactionalSalon = {
    slug?: string;
    feature_flags?: unknown;
    default_language?: string | null;
  };
  let admin: ReturnType<typeof createServiceRoleClient> | null = null;
  let transactionalSalon: TransactionalSalon | null = null;
  try {
    admin = createServiceRoleClient();
    const { data } = await admin
      .from("salons")
      .select("slug, feature_flags, default_language")
      .eq("id", salonId)
      .maybeSingle();
    transactionalSalon = data as TransactionalSalon | null;
  } catch {
    // Existing answer-only chat must remain available if the pilot gate cannot
    // be read. Missing evidence always means tools OFF, never silently ON.
    admin = null;
    transactionalSalon = null;
  }

  const transactionalEnabled = Boolean(
    admin &&
    transactionalSalon?.slug &&
    bookingChatToolsEnabled(transactionalSalon.feature_flags),
  );

  if (transactionalEnabled && admin) {
    // The new paid transactional path gets two durable DB-backed limits. The
    // legacy answer-only path above/below remains byte-for-byte compatible for
    // existing salons because the pilot flag is absent by default.
    const ipHash = crypto.createHash("sha256").update(clientIp(req)).digest("hex");
    const rateResults = await Promise.all([
      admin.rpc("rate_limit_hit", {
        p_key: `booking-chat:ip:${ipHash}`,
        p_limit: 20,
        p_window_seconds: 600,
      }),
      admin.rpc("rate_limit_hit", {
        p_key: `booking-chat:salon:${salonId}`,
        p_limit: 120,
        p_window_seconds: 600,
      }),
    ]);
    if (rateResults.some((result) => result.error)) {
      return new Response("Service unavailable", { status: 503 });
    }
    if (rateResults.some((result) => result.data !== true)) {
      return new Response("Too many requests", { status: 429 });
    }
  }

  // Fetch salon context
  const db = await createClient();
  const { data: salon } = await db
    .from("salons")
    .select("name, description, address, timezone, salon_phone, opening_hours, vertical")
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
      const mins = serviceBlockMinutes(s.duration_minutes, s.buffer_minutes);
      return `- ${s.name}${mins ? ` (${mins} min)` : ""}${price ? ` — ${price}` : ""}`;
    })
    .join("\n");

  const businessDescriptor = resolveVertical(
    (salon as { vertical?: string | null } | null)?.vertical,
  ).aiDescriptor;

  const systemPrompt = `You are a friendly booking assistant for ${salonName}, ${businessDescriptor}. Help customers with questions about services, pricing, hours, and availability. Be concise and warm.

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

  const newest = safeMessages.at(-1);
  if (!newest || newest.role !== "user" || !newest.content.trim()) {
    return new Response("Bad request", { status: 400 });
  }

  const ai = getClient();
  if (!ai) return new Response("AI unavailable", { status: 503 });

  // Transactional AI chat is an explicit, default-OFF salon pilot. When OFF,
  // retain the existing answer-only streaming assistant below. When ON, reuse
  // the same prompt, schemas and executor as Voice/SMS — no parallel booking
  // engine and no weaker mutation path.
  if (
    admin &&
    transactionalEnabled &&
    transactionalSalon?.slug
  ) {
    const toolDb = admin;
    const ctx = await loadSalonContext(transactionalSalon.slug);
    if (!ctx) return new Response("AI unavailable", { status: 503 });

    const likelyVietnamese = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i
      .test(newest.content);
    const language: "vi" | "en" = likelyVietnamese || transactionalSalon.default_language === "vi"
      ? "vi"
      : "en";
    const system = buildSystemPrompt(ctx, language) + BOOKING_CHAT_CHANNEL_NOTE;
    const tools = toAnthropicTools(
      selectWebBookingTools(REALTIME_TOOLS as unknown as RealtimeToolSchema[]),
    );
    const history: StoredTurn[] = safeMessages
      .slice(-BOOKING_CHAT_MAX_HISTORY - 1, -1)
      .map((message) => ({ role: message.role, content: message.content }));

    const complete: LlmComplete = async ({ system: sys, tools: activeTools, messages: working }) => {
      const response = await trackAnthropicMessage(
        {
          salonId,
          feature: "booking_chat",
          model: BOOKING_CHAT_AGENT_MODEL,
        },
        () => ai.messages.create({
          model: BOOKING_CHAT_AGENT_MODEL,
          max_tokens: BOOKING_CHAT_MAX_REPLY_TOKENS,
          system: sys,
          // The SDK types are stricter than the deliberately minimal injected
          // agent types, but these are the same validated Anthropic shapes.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: activeTools as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: working as any,
        }),
      );
      return {
        stop_reason: response.stop_reason,
        content: response.content as unknown as ContentBlock[],
      };
    };

    const callTool = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
      if (!isWebBookingToolName(name)) return { error: "tool_not_allowed" };
      const response = await executeVoiceTool(
        toolDb,
        transactionalSalon!.slug!,
        name,
        input,
        null,
        new URL(req.url).origin,
      );
      return response.json().catch(() => ({ error: "tool_parse_failed" }));
    };

    const result = await runSmsAgent({
      system,
      tools,
      history,
      userText: newest.content,
      complete,
      callTool,
      maxToolTurns: BOOKING_CHAT_MAX_TOOL_TURNS,
    });

    return new Response(result.reply, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  const stream = await trackAnthropicStream(
    {
      salonId,
      feature: "booking_chat",
      model: "claude-haiku-4-5-20251001",
    },
    () => ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: systemPrompt,
      messages: safeMessages,
      stream: true,
    }),
  );

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
