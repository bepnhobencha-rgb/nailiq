"use server";

// Manager Briefing server action.
// Owner sends messages → Claude Sonnet asks the 7 onboarding questions one by one →
// when all are answered it outputs a structured SIP draft JSON.

import Anthropic from "@anthropic-ai/sdk";
import { getDashboardWriteClient } from "@/shared/dashboard/setupActions";
import { isOwnerOrAdmin } from "@/shared/lib/salonMemberRole";
import type { SalonIntelligenceProfile } from "@/shared/ai/types";

// TODO: import buildSip from "@/shared/ai/buildSip" once Agent 1 ships it.
// For now we write the profile directly inside confirmManagerBriefingAction.

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
const SYSTEM_PROMPT = `Bạn là trợ lý AI đang thực hiện "Manager Briefing" — một cuộc phỏng vấn ngắn để cấu hình AI Manager cho tiệm nail/spa. Mục tiêu là thu thập đủ thông tin để tạo ra một Salon Intelligence Profile (SIP).

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
5. Nếu tiệm là một người, họ nói chuyện thế nào — ấm áp hay chuyên nghiệp?
6. Hiện tại ưu tiên gì nhất — giữ khách cũ, kéo khách mới, hay tăng doanh thu?
7. AI được tự làm gì không cần hỏi? Có thứ gì muốn luôn kiểm soát không?

**Khi đã thu thập đủ thông tin từ 7 câu trên:**
- Viết một câu tóm tắt ngắn xác nhận những gì bạn hiểu về tiệm.
- Kết thúc tin nhắn bằng CHÍNH XÁC tag này (không thêm text sau tag):
[SIP_DRAFT]: {JSON}

Trong đó {JSON} là một JSON object hợp lệ với CÁC TRƯỜNG SAU (không thêm, không bỏ bớt):
{
  "vertical": "nail" | "head_spa" | "massage" | "facial" | "waxing" | "multi",
  "brand_voice": "warm_casual" | "warm_professional" | "luxury_formal" | "friendly_fun",
  "language_primary": "en" | "vi" | "zh" | "ko",
  "language_secondary": "en" | "vi" | "zh" | "ko" | null,
  "customer_demographic": "mô tả khách hàng ngắn gọn",
  "noshow_strictness": "lenient" | "moderate" | "strict",
  "contact_window": "HH:MM-HH:MM (ví dụ 9:00-20:00)",
  "winback_cadence": "gentle" | "normal" | "aggressive",
  "primary_goal": "retain_regulars" | "attract_new" | "maximize_revenue",
  "auto_approve": ["send_reminders", "send_winback"] (mảng các action AI tự làm),
  "escalate": ["charge_card", "change_price", "review_response_bad"] (mảng action cần hỏi owner),
  "tone_examples": ["ví dụ câu AI sẽ nhắn khách"],
  "built_at": "ISO string",
  "built_via": "manager_briefing"
}

Ví dụ auto_approve options: "send_reminders", "send_winback", "respond_reviews_good"
Ví dụ escalate options: "charge_card", "change_price", "review_response_bad", "cancel_booking"
`;

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

  // Sanitise history: last 30 turns, trim each message to 2000 chars
  const convo: Anthropic.Messages.MessageParam[] = input.messages
    .slice(-30)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));

  if (convo.length === 0) {
    return { ok: false, error: "no_messages" };
  }

  try {
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: convo,
    });

    const reply = extractText(resp.content);
    if (!reply) {
      return { ok: false, error: "empty_response" };
    }

    const sipDraft = parseSipDraft(reply);
    const isComplete = sipDraft !== null;

    // Strip the [SIP_DRAFT] tag from the displayed reply — the UI shows SipReviewCard instead
    const displayReply = isComplete
      ? reply.slice(0, reply.indexOf("[SIP_DRAFT]:")).trim()
      : reply;

    return { ok: true, reply: displayReply, sipDraft: sipDraft ?? undefined, isComplete };
  } catch (e) {
    console.error("[managerBriefing] generate error", e);
    return { ok: false, error: "server_error" };
  }
}
