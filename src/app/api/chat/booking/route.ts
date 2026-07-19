import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { resolveVertical } from "@/shared/verticals/registry";
import { formatServicePrice } from "@/shared/lib/currencyFormat";
import { loadSalonContext, type SalonVoiceContext } from "@/shared/voiceai/loadSalonContext";
import { executeVoiceTool } from "@/shared/voiceai/toolExecutor";
import { REALTIME_TOOLS } from "@/shared/voiceai/realtimeTools";

export const runtime     = "nodejs";
export const maxDuration = 60;

// ─── Chat receptionist ───────────────────────────────────────────────────────
// Upgraded from Q&A-only to a REAL receptionist: it books, reschedules,
// cancels, waitlists, remembers returning customers, and escalates to the
// owner — through the exact same tool handlers as the voice receptionist
// (@/shared/voiceai/toolExecutor). Voice and chat can never drift apart.
//
// Tool access gating: tools are live when the salon has voice_ai_enabled OR
// feature_flags.ai_chat_booking === true. Otherwise the widget behaves as
// before (informational Q&A + pointer to the booking form).

const CHAT_MODEL      = "claude-haiku-4-5-20251001";
const MAX_TOOL_ROUNDS = 5;

let anthropicClient: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: key });
  return anthropicClient;
}

// end_call is voice-only; every other receptionist tool works over chat.
const CHAT_TOOLS: Anthropic.Tool[] = REALTIME_TOOLS
  .filter((t) => t.name !== "end_call")
  .map((t) => ({
    name:         t.name,
    description:  t.description,
    input_schema: t.parameters as unknown as Anthropic.Tool["input_schema"],
  }));

function buildChatSystemPrompt(ctx: SalonVoiceContext, aiDescriptor: string, toolsEnabled: boolean): string {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: ctx.timezone });

  const serviceList = ctx.services
    .map((s) => {
      const price = formatServicePrice(s.priceCents, ctx.currency, {
        priceType:     s.price_type,
        priceMaxCents: s.price_max_cents,
        fromLabel:     "From",
      });
      return `  • ${s.name} (${s.durationMins} min${price ? `, ${price}` : ""}) [id: ${s.id}]`;
    })
    .join("\n");

  const staffList = ctx.staff.length
    ? ctx.staff.map((m) => `  • ${m.name} [id: ${m.id}]`).join("\n")
    : "  • Any available staff";

  const base = `You are ${ctx.personaName}, the booking assistant for ${ctx.salonName}, ${aiDescriptor}.
Today's date is ${today} (salon timezone: ${ctx.timezone}).
${ctx.address ? `Salon address: ${ctx.address}` : ""}

STYLE:
- Always reply in the same language the customer writes in (Vietnamese or English).
- Warm, concise: 1–3 short sentences per reply unless summarising options.
- Ask ONE question at a time. Never invent prices, times, or policies.

SERVICES:
${serviceList || "  (no services configured — suggest contacting the salon)"}

STAFF:
${staffList}`;

  if (!toolsEnabled) {
    return `${base}

You can answer questions about services, pricing, and hours.
For booking, direct customers to use the booking form on this page.
If unsure about anything, suggest calling the salon.`;
  }

  return `${base}

TOOL RULES:
1. Your tools are the ONLY way to check availability or create/change/cancel/waitlist bookings.
   Saying "booked/confirmed/cancelled" without the matching tool call does NOTHING.
2. ALWAYS call get_available_slots before mentioning any times; only offer returned slots.
   Resolve relative dates (mai / ngày mai / tomorrow / this Saturday) using today's date above.
3. Individual flow: service → date → time (from get_available_slots) → staff preference → name → phone → confirm_booking.
4. Groups of 2+ → get_group_available_slots + confirm_group_booking only (organizer name + phone; never per-member names).
5. MEMORY: the FIRST time the customer provides their phone number, call lookup_customer.
   If known, greet them by name and offer their usual service/staff first.
   Use allergies only to avoid recommending allergens — never recite them.
   Never mention visit counts, spend, notes, or that you "looked them up".
6. Reschedule = reschedule_booking (never cancel + rebook). No booking_id? find_booking by phone first.
7. Cancel: look up by phone first (cancel_booking with customer_phone), read the booking back,
   get an explicit "yes", then cancel with booking_id.
8. Nothing available and no alternative works → offer join_waitlist (make clear it is NOT a booking).
9. ESCALATION: complaints, refunds, price exceptions, or anything beyond your tools →
   collect name + phone + message and call leave_message_for_owner. Never argue or improvise policy.
10. After confirm_booking succeeds, recap: service, date, time, staff — and whether an SMS confirmation was sent.`;
}

type InMsg = { role: "user" | "assistant"; content: string };

export async function POST(req: NextRequest) {
  const { salonId, messages, chatSessionId } = (await req.json()) as {
    salonId: string;
    messages: InMsg[];
    chatSessionId?: string;
  };

  if (!salonId || !Array.isArray(messages) || messages.length === 0) {
    return new Response("Bad request", { status: 400 });
  }

  let supabase: ReturnType<typeof createServiceRoleClient>;
  try {
    supabase = createServiceRoleClient();
  } catch {
    return new Response("AI unavailable", { status: 503 });
  }

  const { data: salon } = await supabase
    .from("salons")
    .select("id, slug, vertical, voice_ai_enabled, feature_flags")
    .eq("id", salonId)
    .maybeSingle();
  if (!salon) return new Response("Salon not found", { status: 404 });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = salon as any;
  const flags = (s.feature_flags ?? {}) as Record<string, unknown>;
  const toolsEnabled = s.voice_ai_enabled === true || flags.ai_chat_booking === true;

  const ctx = await loadSalonContext(s.slug as string);
  if (!ctx) return new Response("Salon not found", { status: 404 });

  const aiDescriptor = resolveVertical(s.vertical as string | null).aiDescriptor;
  const systemPrompt = buildChatSystemPrompt(ctx, aiDescriptor, toolsEnabled);

  // Sanitize: last 10 messages, user/assistant only, trim content
  const safeMessages: Anthropic.MessageParam[] = messages
    .slice(-10)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 500) }));

  const ai = getClient();
  if (!ai) return new Response("AI unavailable", { status: 503 });

  const baseUrl = new URL(req.url).origin;
  const convo: Anthropic.MessageParam[] = [...safeMessages];
  let resultingBookingId: string | null = null;
  let finalText = "";

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const response = await ai.messages.create({
        model:      CHAT_MODEL,
        max_tokens: 1024,
        system:     systemPrompt,
        messages:   convo,
        ...(toolsEnabled ? { tools: CHAT_TOOLS } : {}),
      });

      const textBlocks = response.content.filter((b) => b.type === "text");
      const toolBlocks = response.content.filter((b) => b.type === "tool_use");

      if (response.stop_reason !== "tool_use" || toolBlocks.length === 0 || round === MAX_TOOL_ROUNDS) {
        finalText = textBlocks.map((b) => (b as Anthropic.TextBlock).text).join("");
        break;
      }

      convo.push({ role: "assistant", content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolBlocks) {
        const tu = block as Anthropic.ToolUseBlock;
        let resultJson: unknown;
        try {
          const res = await executeVoiceTool(
            supabase,
            s.slug as string,
            tu.name,
            (tu.input ?? {}) as Record<string, unknown>,
            null,
            baseUrl,
          );
          resultJson = await res.json();
          const maybeBooking = resultJson as { bookingId?: string; success?: boolean };
          if (maybeBooking.success && maybeBooking.bookingId) {
            resultingBookingId = maybeBooking.bookingId;
          }
        } catch (err) {
          resultJson = { error: "tool_failed", detail: err instanceof Error ? err.message : String(err) };
        }
        toolResults.push({
          type:        "tool_result",
          tool_use_id: tu.id,
          content:     JSON.stringify(resultJson).slice(0, 4000),
        });
      }
      convo.push({ role: "user", content: toolResults });
    }
  } catch (err) {
    console.error("[chat/booking] agent loop failed", err);
    return new Response("AI unavailable", { status: 503 });
  }

  if (!finalText.trim()) {
    finalText = "Xin lỗi, hệ thống đang bận. Bạn thử lại giúp mình nhé!";
  }

  // ── ai_chats logging (best-effort, keyed by client-provided session id) ────
  if (chatSessionId && typeof chatSessionId === "string" && chatSessionId.length <= 64) {
    try {
      const lastUser = safeMessages[safeMessages.length - 1];
      const { data: existing } = await supabase
        .from("ai_chats")
        .select("id, messages, message_count")
        .eq("salon_id", s.id)
        .eq("session_id", chatSessionId)
        .maybeSingle();

      const newEntries = [
        { at: new Date().toISOString(), role: "user",      content: String(lastUser?.content ?? "").slice(0, 500) },
        { at: new Date().toISOString(), role: "assistant", content: finalText.slice(0, 1000) },
      ];

      if (existing) {
        const prior = Array.isArray(existing.messages) ? (existing.messages as unknown[]) : [];
        await supabase
          .from("ai_chats")
          .update({
            messages:        [...prior.slice(-98), ...newEntries],
            message_count:   (existing.message_count ?? 0) + 2,
            last_message_at: new Date().toISOString(),
            ...(resultingBookingId ? { resulting_booking_id: resultingBookingId, status: "converted" } : {}),
          })
          .eq("id", existing.id);
      } else {
        await supabase.from("ai_chats").insert({
          salon_id:        s.id,
          session_id:      chatSessionId,
          messages:        newEntries,
          message_count:   2,
          status:          resultingBookingId ? "converted" : "active",
          last_message_at: new Date().toISOString(),
          ...(resultingBookingId ? { resulting_booking_id: resultingBookingId } : {}),
        });
      }
    } catch { /* best-effort — logging must never break the chat */ }
  }

  // Keep the streaming response shape the widget already understands.
  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(finalText));
      controller.close();
    },
  });

  return new Response(readable, {
    headers: {
      "content-type":      "text/plain; charset=utf-8",
      "x-accel-buffering": "no",
      "cache-control":     "no-store",
    },
  });
}
