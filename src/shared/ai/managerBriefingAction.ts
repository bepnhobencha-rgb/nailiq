"use server";

// Manager Briefing server action.
// Owner sends messages → Claude Sonnet asks the 7 onboarding questions one by one →
// when all are answered it outputs a structured SIP draft JSON.

import Anthropic from "@anthropic-ai/sdk";
import { trackAnthropicMessage } from "@/shared/ai/usageLedger";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import type { SalonIntelligenceProfile } from "@/shared/ai/types";

// SIP is written by confirmManagerBriefingAction from the conversation output.
// buildSip.ts handles the programmatic (non-conversational) rebuild path.

export type BriefingMessage = { role: "user" | "assistant"; content: string };

export type BriefingResult =
  | { ok: true; reply: string; sipDraft?: SalonIntelligenceProfile; isComplete: boolean }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Anthropic client (lazy singleton)
// ---------------------------------------------------------------------------
let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!_client) _client = new Anthropic({ apiKey: key });
  return _client;
}

function extractText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
// System prompts — full 7-question vs. smart 2-question (when SIP exists)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_COLD = `Bạn là Minh — AI Manager của NailIQ — đang thực hiện "Manager Briefing" để cấu hình cho tiệm nail/spa. Mục tiêu là thu thập đủ thông tin để tạo ra Salon Intelligence Profile (SIP).

**Quy tắc quan trọng:**
- Hỏi từng câu một, KHÔNG hỏi nhiều câu cùng lúc.
- Lắng nghe câu trả lời, xác nhận ngắn gọn rồi hỏi câu tiếp theo.
- Giọng điệu: ấm áp, thân thiện, ngắn gọn — như người bạn đồng nghiệp, không phải form giấy tờ.
- Nếu câu trả lời mơ hồ, hỏi một câu làm rõ TRƯỚC khi chuyển sang câu tiếp.
- Sau khi đã hỏi đủ 7 câu và có câu trả lời hợp lý, xuất SIP draft.

**7 câu hỏi cần thu thập (theo thứ tự):**
1. Tiệm làm dịch vụ gì? Ở đâu? Bao nhiêu nhân viên?
2. Khách hàng chủ yếu là ai? Họ nói tiếng gì?
3. No-show có phải vấn đề lớn không? Đang xử lý thế nào?
4. Muốn liên hệ khách bao thường? Có giờ nào không nên nhắn không?
5. Khi nhắn tin cho khách, bạn thích dùng giọng thế nào — thân mật như bạn bè, hay lịch sự chuyên nghiệp? Cho ví dụ câu nhắn bạn hay dùng nếu được.
6. Hiện tại ưu tiên gì nhất — giữ khách cũ, kéo khách mới, hay tăng doanh thu?
7. AI được tự làm gì không cần hỏi? Có thứ gì muốn luôn kiểm soát không?

**Khi đã thu thập đủ thông tin:**
- Viết một câu tóm tắt ngắn xác nhận những gì bạn hiểu về tiệm.
- Kết thúc bằng CHÍNH XÁC tag này (không thêm text sau tag):
[SIP_DRAFT]: {JSON}`;

/** Build a smart 2-question prompt when auto-SIP already exists. */
function buildSmartSystemPrompt(sip: SalonIntelligenceProfile, salonName: string): string {
  const verticalLabel: Record<string, string> = {
    nail: "nail salon", head_spa: "head spa", massage: "massage", facial: "facial",
    waxing: "waxing", multi: "dịch vụ đa dạng",
  };
  const strictnessLabel: Record<string, string> = {
    lenient: "nhẹ nhàng", moderate: "vừa phải", strict: "nghiêm ngặt",
  };
  const voiceLabel: Record<string, string> = {
    warm_casual: "thân mật, gần gũi",
    warm_professional: "ấm áp, chuyên nghiệp",
    luxury_formal: "sang trọng, lịch sự",
    friendly_fun: "vui vẻ, thân thiện",
  };

  return `Bạn là Minh — AI Manager của NailIQ. Bạn đã tự học từ dữ liệu tiệm ${salonName} và có SIP (Salon Intelligence Profile) sẵn:

**Những gì Minh đã biết từ data:**
- Loại tiệm: ${verticalLabel[sip.vertical] ?? sip.vertical}
- Ngôn ngữ chính: ${sip.language_primary}
- Chính sách no-show: ${strictnessLabel[sip.noshow_strictness] ?? sip.noshow_strictness}
- Giờ liên lạc: ${sip.contact_window}
- Giọng điệu đang dùng: ${voiceLabel[sip.brand_voice] ?? sip.brand_voice}
- Mục tiêu: ${sip.primary_goal}

**Nhiệm vụ:** Chỉ cần hỏi 2 điều Minh không thể đoán từ data:

**Câu 1 (giọng nhắn tin):** Hỏi: "Minh đã đoán tiệm bạn dùng giọng [voiceLabel[sip.brand_voice]]. Đúng không? Nếu muốn điều chỉnh, cho Minh xem ví dụ câu bạn thường nhắn khách nhé."
**Câu 2 (quyền tự làm):** Hỏi: "Minh nên tự làm gì không cần hỏi bạn — và có thứ gì Minh cần xin phép trước không?"

Sau khi có câu trả lời cho cả 2 câu, cập nhật SIP và xuất ngay.

**Lấy SIP hiện tại làm nền, chỉ cập nhật brand_voice, tone_examples, auto_approve, escalate từ câu trả lời của owner.**

Kết thúc bằng CHÍNH XÁC tag này:
[SIP_DRAFT]: {JSON}

SIP JSON fields (giữ nguyên phần đã biết từ data, chỉ cập nhật những field liên quan đến 2 câu hỏi trên):
{
  "vertical": "${sip.vertical}",
  "brand_voice": "warm_casual" | "warm_professional" | "luxury_formal" | "friendly_fun",
  "language_primary": "${sip.language_primary}",
  "language_secondary": ${JSON.stringify(sip.language_secondary ?? null)},
  "customer_demographic": ${JSON.stringify(sip.customer_demographic ?? "")},
  "noshow_strictness": "${sip.noshow_strictness}",
  "contact_window": "${sip.contact_window}",
  "winback_cadence": "${sip.winback_cadence}",
  "primary_goal": "${sip.primary_goal}",
  "auto_approve": [...],
  "escalate": [...],
  "tone_examples": [...],
  "built_at": "ISO string",
  "built_via": "manager_briefing"
}`;
}

// ---------------------------------------------------------------------------
// SIP parser — extracts JSON after [SIP_DRAFT]: tag
// ---------------------------------------------------------------------------
function parseSipDraft(text: string): SalonIntelligenceProfile | null {
  const marker = "[SIP_DRAFT]: ";
  const idx = text.indexOf(marker);
  if (idx === -1) return null;
  try {
    const raw = text.slice(idx + marker.length).trim();
    const parsed = JSON.parse(raw) as Partial<SalonIntelligenceProfile>;
    // Minimal validation — must have the required fields
    if (!parsed.vertical || !parsed.brand_voice || !parsed.language_primary) return null;
    // Ensure built_at is set
    if (!parsed.built_at) parsed.built_at = new Date().toISOString();
    if (!parsed.built_via) parsed.built_via = "manager_briefing";
    return parsed as SalonIntelligenceProfile;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main action
// ---------------------------------------------------------------------------
export async function runManagerBriefing(input: {
  slug: string;
  messages: BriefingMessage[];
  existingSip?: SalonIntelligenceProfile | null;
  salonName?: string;
}): Promise<BriefingResult> {
  const ctx = await getDashboardWriteClient(input.slug);
  if (!ctx) return { ok: false, error: "unauthorized" };
  if (!isOwnerOrAdmin(ctx.role)) return { ok: false, error: "forbidden" };

  const anthropic = getClient();
  if (!anthropic) {
    return {
      ok: true,
      reply:
        "AI chưa sẵn sàng — thiếu ANTHROPIC_API_KEY. Vui lòng cấu hình key trong biến môi trường.",
      isComplete: false,
    };
  }

  const systemPrompt =
    input.existingSip
      ? buildSmartSystemPrompt(input.existingSip, input.salonName ?? input.slug)
      : SYSTEM_PROMPT_COLD;

  // Sanitise history: last 30 turns, trim each message to 2000 chars
  const convo: Anthropic.Messages.MessageParam[] = input.messages
    .slice(-30)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));

  if (convo.length === 0) {
    return { ok: false, error: "no_messages" };
  }

  try {
    const resp = await trackAnthropicMessage(
      {
        salonId: ctx.salon.id,
        feature: "manager_briefing",
        model: "claude-sonnet-4-5",
      },
      () => anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 1500,
        system: systemPrompt,
        messages: convo,
      }),
    );

    const reply = extractText(resp.content);
    if (!reply) {
      return { ok: false, error: "empty_response" };
    }

    const sipDraft = parseSipDraft(reply);
    const isComplete = sipDraft !== null;

    // Always strip [SIP_DRAFT] block — even if JSON parse failed, raw JSON must not show in UI
    const sipIdx = reply.indexOf("[SIP_DRAFT]:");
    const displayReply = sipIdx !== -1 ? reply.slice(0, sipIdx).trim() : reply;

    return { ok: true, reply: displayReply, sipDraft: sipDraft ?? undefined, isComplete };
  } catch (e) {
    console.error("[managerBriefing] generate error", e);
    return { ok: false, error: "server_error" };
  }
}
