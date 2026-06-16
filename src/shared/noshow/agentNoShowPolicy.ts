import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { resolvePaymentProvider } from "@/shared/integrations/payments";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";

/**
 * AI No-Show Policy Agent — the first "AI brain on a deterministic spine".
 *
 * Instead of a hardcoded threshold (risk ≥ 60, new/returning, fixed deposit %),
 * an AI weighs the WHOLE customer context and decides the protection per booking
 * in a flexible, human way (require a card, take a deposit, or trust them) AND
 * drafts the customer-facing ask. The AI NEVER charges and NEVER acts directly:
 *  - clampAndGuard() (deterministic) validates/clamps the AI's output,
 *  - in SHADOW mode the decision is only LOGGED (ai_policy_decisions) vs the
 *    existing rule, so the owner reviews quality on real data first,
 *  - downstream charging stays consent-gated + idempotent (unchanged).
 */

const str = (v: unknown): string => (v == null ? "" : String(v));
const num = (v: unknown): number => (v == null ? 0 : Number(v));

export type Protection = "none" | "card" | "deposit";

export type PolicyContext = {
  bookingId: string;
  salonId: string;
  clientName: string;
  serviceName: string;
  priceCents: number;
  startTimeUtc: string;
  channel: string;
  hasEmail: boolean;
  hasPhone: boolean;
  isNew: boolean;
  visitCount: number;
  noShowCount: number;
  isVip: boolean;
  vertical: string;
  protectionEnabled: boolean;
  providerConnected: boolean;
  defaultFeePercent: number;
  maxFeePercent: number;
  /** salons.feature_flags.ai_noshow_policy_shadow — gates the (paid) AI call. */
  aiShadowEnabled: boolean;
};

export type AiPolicyDecision = {
  protection: Protection;
  feePercent: number;
  reason: string;
  message: string | null;
  confidence: "low" | "medium" | "high";
};

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  if (!client) client = new Anthropic({ apiKey: key });
  return client;
}

/** Pull everything the agent reasons over (off the hot path). */
export async function gatherPolicyContext(bookingId: string): Promise<PolicyContext | null> {
  const db = looseServiceClient();
  const { data } = await db
    .from("bookings")
    .select("id, salon_id, client_name, client_phone, client_email, service_id, price_cents, start_time_utc, booking_channel, source")
    .eq("id", bookingId)
    .maybeSingle();
  const b = data as Row | null;
  if (!b) return null;

  const salonId = str(b.salon_id);
  const phone = str(b.client_phone).replace(/\D/g, "");

  const [{ data: svc }, { data: salon }, { data: profile }, provider] = await Promise.all([
    b.service_id ? db.from("services").select("name").eq("id", str(b.service_id)).maybeSingle() : Promise.resolve({ data: null }),
    db.from("salons").select("vertical, noshow_protection_enabled, noshow_fee_percent, feature_flags").eq("id", salonId).maybeSingle(),
    phone.length >= 8
      ? db.from("client_profiles").select("visit_count, no_show_count, is_vip").eq("salon_id", salonId).eq("phone", phone).maybeSingle()
      : Promise.resolve({ data: null }),
    resolvePaymentProvider(salonId),
  ]);

  const s = (salon as Row | null) ?? {};
  const p = (profile as Row | null) ?? {};
  const visitCount = num(p.visit_count);

  return {
    bookingId: str(b.id),
    salonId,
    clientName: str(b.client_name) || "Khách",
    serviceName: str((svc as Row | null)?.name) || "dịch vụ",
    priceCents: num(b.price_cents),
    startTimeUtc: str(b.start_time_utc),
    channel: str(b.booking_channel) || str(b.source) || "online",
    hasEmail: str(b.client_email).trim().length > 0,
    hasPhone: phone.length >= 8,
    isNew: visitCount <= 0,
    visitCount,
    noShowCount: num(p.no_show_count),
    isVip: p.is_vip === true,
    vertical: str(s.vertical) || "nail salon",
    protectionEnabled: s.noshow_protection_enabled === true,
    providerConnected: Boolean(provider),
    defaultFeePercent: num(s.noshow_fee_percent) || 20,
    maxFeePercent: 50,
    aiShadowEnabled:
      (s.feature_flags as Record<string, unknown> | null)?.ai_noshow_policy_shadow === true,
  };
}

/** ① AI BRAIN — decide the protection + draft the ask. Returns null on failure. */
export async function agentDecideNoShowPolicy(ctx: PolicyContext): Promise<AiPolicyDecision | null> {
  const ai = getClient();
  if (!ai) return null;

  const when = new Date(ctx.startTimeUtc).toLocaleString("vi-VN", { timeZone: "America/Los_Angeles" });
  const prompt = `Bạn là quản lý phụ trách chính sách chống no-show cho một ${ctx.vertical}. Quyết định mức bảo vệ cho lượt hẹn này một cách LINH HOẠT và NHÂN VĂN (giữ trải nghiệm cao cấp cho khách quen, chặt với rủi ro thật), KHÔNG máy móc theo ngưỡng.

Lựa chọn:
- "none": tin khách, không đòi gì.
- "card": yêu cầu lưu thẻ (chỉ bị trừ phí nếu thật sự vắng).
- "deposit": yêu cầu đặt cọc trước.

Bối cảnh:
- Khách: ${ctx.clientName} | ${ctx.isNew ? "KHÁCH MỚI" : `quay lại, đã đến ${ctx.visitCount} lần`} | số lần no-show trước: ${ctx.noShowCount} | VIP: ${ctx.isVip}
- Liên hệ: ${ctx.hasPhone ? "có SĐT" : "KHÔNG SĐT"}, ${ctx.hasEmail ? "có email" : "không email"}
- Lượt hẹn: ${ctx.serviceName}, giá ~$${(ctx.priceCents / 100).toFixed(0)}, lúc ${when}, kênh ${ctx.channel}
- Tiệm: bảo vệ no-show ${ctx.protectionEnabled ? "BẬT" : "TẮT"}, cổng thanh toán ${ctx.providerConnected ? "đã nối" : "CHƯA nối"}, phí mặc định ${ctx.defaultFeePercent}%.

Nếu chọn card/deposit, soạn 1 lời nhắn ngắn, ấm áp, lịch sự cho khách bằng tiếng Việt (xưng hô thân thiện).

Chỉ trả JSON: {"protection":"none|card|deposit","feePercent":<0-${ctx.maxFeePercent}>,"reason":"<1 câu tiếng Việt vì sao>","message":"<lời nhắn hoặc null>","confidence":"low|medium|high"}`;

  try {
    const resp = await ai.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as Partial<AiPolicyDecision>;
    const protection: Protection =
      parsed.protection === "card" || parsed.protection === "deposit" ? parsed.protection : "none";
    return {
      protection,
      feePercent: typeof parsed.feePercent === "number" ? parsed.feePercent : ctx.defaultFeePercent,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      message: typeof parsed.message === "string" && parsed.message.trim() ? parsed.message.trim() : null,
      confidence: parsed.confidence === "low" || parsed.confidence === "high" ? parsed.confidence : "medium",
    };
  } catch {
    return null;
  }
}

/** ② CODE SPINE — validate + clamp the AI output. Returns null → caller falls
 *  back to the deterministic rule (low confidence, AI failure, unsafe output). */
export function clampAndGuard(ai: AiPolicyDecision | null, ctx: PolicyContext): AiPolicyDecision | null {
  if (!ai) return null;
  if (ai.confidence === "low") return null; // not sure enough → let the rule decide

  // Can only ask for money when a provider is connected + protection is on.
  if ((ai.protection === "card" || ai.protection === "deposit") && (!ctx.providerConnected || !ctx.protectionEnabled)) {
    return { protection: "none", feePercent: 0, reason: `${ai.reason} (cổng/bảo vệ chưa sẵn → không đòi)`, message: null, confidence: ai.confidence };
  }
  // VIP courtesy guard (kept conservative for v1).
  if (ctx.isVip && ai.protection !== "none") {
    return { protection: "none", feePercent: 0, reason: `${ai.reason} (VIP → giữ ưu ái, không đòi)`, message: null, confidence: ai.confidence };
  }
  // Clamp the fee/deposit percent to the salon's allowed band.
  const feePercent = ai.protection === "none" ? 0 : Math.min(ctx.maxFeePercent, Math.max(0, Math.round(ai.feePercent || 0)));
  return { ...ai, feePercent };
}

/**
 * SHADOW MODE — run the agent alongside the existing rule and RECORD the
 * comparison, WITHOUT changing anything. Best-effort; never throws.
 */
export async function runNoShowPolicyShadow(bookingId: string): Promise<void> {
  try {
    const ctx = await gatherPolicyContext(bookingId);
    if (!ctx) return;
    if (!ctx.aiShadowEnabled) return; // salon hasn't opted into the shadow agent

    const aiRaw = await agentDecideNoShowPolicy(ctx);
    const ai = clampAndGuard(aiRaw, ctx);

    // What the current deterministic rule would do (card vs none).
    let ruleProtection: Protection = "none";
    try {
      const { noShowCardDecision } = await import("@/shared/integrations/square/noshow");
      if ((await noShowCardDecision(bookingId)).required) ruleProtection = "card";
    } catch {
      /* leave as none */
    }

    const db = createServiceRoleClient();
    await db.from("ai_policy_decisions" as never).insert({
      salon_id: ctx.salonId,
      booking_id: bookingId,
      agent: "noshow_policy",
      mode: "shadow",
      ai_protection: ai?.protection ?? "none",
      ai_fee_percent: ai?.feePercent ?? null,
      ai_reason: ai?.reason ?? (aiRaw ? "(bị guard chặn)" : "(AI không phản hồi → dùng rule)"),
      ai_message: ai?.message ?? null,
      ai_confidence: ai?.confidence ?? null,
      rule_protection: ruleProtection,
      applied: false,
    } as never);
  } catch (e) {
    console.error("[runNoShowPolicyShadow]", e);
  }
}

/**
 * Backfill shadow decisions for a salon's EXISTING upcoming bookings — most
 * Hi-Lite bookings arrive via the Square sync (not the NailIQ online flow), so
 * the per-booking hook never fires for them. Called from the square-sync cron
 * (prod, where ANTHROPIC_API_KEY exists). Self-gated on the salon's opt-in flag;
 * caps the AI calls per run so the log fills steadily. Best-effort.
 */
export async function backfillNoShowShadow(salonId: string, cap = 5): Promise<void> {
  try {
    const db = looseServiceClient();
    const { data: salon } = await db.from("salons").select("feature_flags").eq("id", salonId).maybeSingle();
    const on = ((salon as Row | null)?.feature_flags as Record<string, unknown> | null)?.ai_noshow_policy_shadow === true;
    if (!on) return;

    const { data: done } = await db.from("ai_policy_decisions").select("booking_id").eq("salon_id", salonId).limit(1000);
    const seen = new Set(((done ?? []) as Row[]).map((r) => str(r.booking_id)));

    const { data: bookings } = await db
      .from("bookings")
      .select("id")
      .eq("salon_id", salonId)
      .in("status", ["confirmed", "pending"])
      .gt("start_time_utc", new Date().toISOString())
      .order("start_time_utc", { ascending: true })
      .limit(80);

    let ran = 0;
    for (const b of (bookings ?? []) as Row[]) {
      if (ran >= cap) break;
      const id = str(b.id);
      if (seen.has(id)) continue;
      await runNoShowPolicyShadow(id);
      ran++;
    }
  } catch (e) {
    console.error("[backfillNoShowShadow]", e);
  }
}
