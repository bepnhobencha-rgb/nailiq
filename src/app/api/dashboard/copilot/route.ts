import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { trackAnthropicMessage } from "@/shared/ai/usageLedger";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isReleaseFeatureEnabled } from "@/shared/features/featureRegistry";
import { copilotRateLimit } from "@/shared/copilot/copilotRateLimit";
import { SOP_KNOWLEDGE } from "@/shared/copilot/sopKnowledge";
import {
  buildCopilotContext,
  COPILOT_TOOLS,
  runCopilotTool,
  type CocoBookingProposal,
} from "@/shared/copilot/copilotContext";
import type { SalonMemberRole } from "@/shared/lib/salonMemberRole";

// Agentic "Coco" copilot for the salon dashboard. Grounded in the SOP, plus a
// LIVE snapshot of this salon + this user (role, reachable areas, today's
// real-time state, setup gaps). It can call a read-only tool to look up a
// client's appointments. It guides and reads; it never mutates data — any
// "do it for me" is surfaced as a deep-link to the page where the real,
// already-validated action lives.

export const maxDuration = 40;
export const dynamic = "force-dynamic";

type Lang = "en" | "vi";
type Msg = { role: "user" | "assistant"; content: string };

let anthropicClient: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey: key });
  return anthropicClient;
}

function extractText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function systemPrompt(lang: Lang, role: string, contextBlock: string, slug: string, path?: string): string {
  const replyLang = lang === "vi" ? "Vietnamese" : "English";
  return `You are **Coco**, the friendly in-app assistant for NailIQ, inside the salon dashboard.
Persona: warm, cute, and encouraging, but professional and accurate. Refer to yourself as "Coco". Keep it light — don't overuse the name or emojis.
Your user works at a nail salon and may NOT be tech-savvy. Their role: ${role}.
${path ? `They are currently on the page: ${path}` : ""}

You have TWO sources of truth:
1) The SOP below — how every feature works (areas + flows).
2) The LIVE CONTEXT below — this salon's config, this user's role, and today's real-time state.

How to help:
- Answer in ${replyLang}, warm and simple, no jargon. Use short numbered steps with **bold** names for pages/actions.
- ALWAYS personalise using the live context. Don't guide features the user's role can't reach — if they lack access, tell them to ask the owner/admin.
- Be PROACTIVE: if the live context shows a setup gap or pending work (walk-ins waiting, no-shows today, missing services/staff), surface it and offer the next step.
- WOW with one-tap navigation: whenever you explain how to do something, ALWAYS finish your answer with the deep-link to that exact page on its OWN line — it renders as a big tappable "Open …" button so the user jumps straight there instead of hunting for the menu. e.g. [Open Front Desk](/dashboard/${slug}/center) or [Open Settings](/dashboard/${slug}/settings). The real action buttons live on that page. Build links as /dashboard/${slug}/... — only link to pages the user's role can actually reach.
- CHANGE LANGUAGE FOR THEM: when the user asks how to switch the dashboard language (EN/VI), don't describe menus — give a one-tap deep-link that DOES it: append \`?setLang=vi\` (or \`?setLang=en\`) to a page they can reach, e.g. [Chuyển sang tiếng Việt](/dashboard/${slug}/center?setLang=vi). Tapping switches their language instantly (per-user). See SOP section N.
- Use the find_appointment tool when the user asks about a specific client's appointment (by name or phone).
- OPEN AN APPOINTMENT FOR THEM: when the user wants to act on a specific booking you found (cancel, reschedule, start/complete, see details), don't make them hunt for it — give a deep-link that OPENS THAT EXACT booking on its own line, using the id + date from find_appointment: [Open NAME's appointment](/dashboard/${slug}/center?date=DATE&booking=ID). It opens the Front Desk on that day with the booking's detail drawer already open, where the Cancel / Edit / status buttons live. (You can't cancel it yourself — that drawer button does.)
- BOOKING FOR THE USER: when they ask you to actually create/book an appointment, collect the customer name, phone, service, staff (or "any"), date, and time — ask for whatever is missing FIRST — then call prepare_appointment. It returns a proposal the user must confirm with a button; reply with a short friendly summary and tell them to tap **Confirm** to book. NEVER claim the appointment is booked — the Confirm button does that. If prepare_appointment returns ok:false, relay its message (e.g. ask which service/staff, or pick a non-past time).
- If something isn't in the SOP and isn't in the live context, say honestly you don't have it — NEVER invent steps, page names, paths, or numbers.
- You only guide and read; you cannot change data yourself.

${contextBlock}

=== SOP (how features work) ===
${SOP_KNOWLEDGE}
=== END SOP ===`;
}

export async function POST(req: NextRequest) {
  let body: { slug?: string; messages?: Msg[]; lang?: string; path?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const slug = typeof body.slug === "string" ? body.slug : "";
  const lang: Lang = body.lang === "vi" ? "vi" : "en";
  const path = typeof body.path === "string" ? body.path.slice(0, 200) : undefined;
  const messages = Array.isArray(body.messages) ? body.messages : [];

  if (!slug || messages.length === 0) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Auth + tenant: a real member of this salon (or valid demo cookie).
  const ctx = await getDashboardWriteClient(slug);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const role = ctx.role as SalonMemberRole;
  // nail_tech is view-only; the copilot is for operational guidance.
  if (role === "nail_tech") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Feature gate (defence in depth — the UI also hides Coco when disabled).
  const { data: flagRow } = await ctx.supabase
    .from("salons")
    .select("subscription_plan, plan_override, feature_flags, voice_ai_enabled" as never)
    .eq("id", ctx.salon.id)
    .maybeSingle();
  if (!isReleaseFeatureEnabled((flagRow ?? {}) as never, "admin_copilot")) {
    return NextResponse.json({ error: "not_enabled" }, { status: 403 });
  }

  // Rate limit per user (fall back to slug when the auth id is unavailable).
  const { data: auth } = await ctx.supabase.auth.getUser();
  const rlKey = `copilot:${auth.user?.id ?? slug}`;
  const rl = copilotRateLimit(rlKey, 40, 60 * 60 * 1000);
  if (!rl.ok) {
    const msg = lang === "vi"
      ? `Bạn đang hỏi nhanh quá — thử lại sau ${rl.retryAfterSec}s.`
      : `You're asking very fast — please retry in ${rl.retryAfterSec}s.`;
    return NextResponse.json({ error: msg }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }

  const anthropic = getClient();
  if (!anthropic) {
    const msg = lang === "vi"
      ? "Trợ lý AI chưa sẵn sàng — thiếu cấu hình API key."
      : "AI assistant isn't ready — the API key is not configured.";
    return NextResponse.json({ error: msg }, { status: 503 });
  }

  try {
    const contextBlock = await buildCopilotContext({ db: ctx.supabase, salon: ctx.salon, role });
    const system = systemPrompt(lang, role, contextBlock, slug, path);
    const tz = ctx.salon.timezone || "America/Los_Angeles";

    // Sanitise history: last 20, user/assistant only, trimmed.
    const convo: Anthropic.Messages.MessageParam[] = messages
      .slice(-20)
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));

    // Agentic loop: let Coco call read-only tools, then answer. A
    // `prepare_appointment` call yields a structured proposal the client turns
    // into a confirm card — the params never depend on the model's prose.
    let finalText = "";
    let proposal: CocoBookingProposal | null = null;
    for (let step = 0; step < 4; step++) {
      const resp = await trackAnthropicMessage(
        {
          salonId: ctx.salon.id,
          feature: "admin_copilot",
          model: "claude-haiku-4-5-20251001",
        },
        () => anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1500,
          system,
          tools: COPILOT_TOOLS,
          messages: convo,
        }),
      );

      if (resp.stop_reason === "tool_use") {
        convo.push({ role: "assistant", content: resp.content });
        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
        for (const block of resp.content) {
          if (block.type === "tool_use") {
            const out = await runCopilotTool({
              db: ctx.supabase,
              salonId: ctx.salon.id,
              timezone: tz,
              name: block.name,
              input: block.input as Record<string, unknown>,
            });
            if (out.proposal) proposal = out.proposal;
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: out.content });
          }
        }
        convo.push({ role: "user", content: toolResults });
        continue;
      }

      finalText = extractText(resp.content);
      break;
    }

    if (!finalText) {
      finalText = lang === "vi"
        ? "Xin lỗi, Coco chưa trả lời được. Bạn thử hỏi lại nhé."
        : "Sorry, Coco couldn't answer that. Please try again.";
    }
    return NextResponse.json({ text: finalText, proposal });
  } catch (e) {
    console.error("[copilot] generate", e);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
