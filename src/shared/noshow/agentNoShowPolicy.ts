import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { looseServiceClient, type Row } from "@/shared/integrations/square/looseDb";
import { resolvePaymentProvider } from "@/shared/integrations/payments";
import { createServiceRoleClient } from "@/shared/lib/supabase/serviceRole";
import { isAiAgentPermissionEnabled } from "@/shared/ai/agentPermissionFence";
import {
  claimAiExecutionSlot,
  ruleFirstOptimizationEnabled,
} from "@/shared/ai/executionLimit";
import { trackAnthropicMessage } from "@/shared/ai/usageLedger";
import { deterministicNoShowRiskScore } from "@/shared/noshow/scoreNoShowRisk";

/**
 * AI No-Show Policy Agent — the first "AI brain on a deterministic spine".
 *
 * Instead of a hardcoded threshold (risk ≥ 60, new/returning, fixed deposit %),
 * an AI weighs the WHOLE customer context and decides the protection per booking
 * in a flexible, human way (require a card or trust them) AND
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
  /** Protection already exists on this booking; never ask for it again. */
  hasCardOnFile: boolean;
  hasActiveDeposit: boolean;
  /** Hours between booking creation and appointment start. */
  leadTimeHours: number;
  isNew: boolean;
  visitCount: number;
  noShowCount: number;
  isVip: boolean;
  vertical: string;
  protectionEnabled: boolean;
  providerConnected: boolean;
  defaultFeePercent: number;
  maxFeePercent: number;
  /** salons.feature_flags.ai_noshow_policy_shadow — log-only (no effect). */
  aiShadowEnabled: boolean;
  /** salons.feature_flags.ai_noshow_policy_live — AI decision DRIVES the flag. */
  aiLiveEnabled: boolean;
  ruleFirstOptimizationEnabled: boolean;
  /** Primary language for customer-facing messages ("en" | "vi"). Defaults to "en". */
  language: "en" | "vi";
  // Group booking context — needed so the AI reasons about the whole-party fee,
  // not just the organizer's single-slot price (PR #586: noshow_group_whole_party).
  /** True when this booking belongs to a group with 2+ active members. */
  isGroupBooking: boolean;
  /** Number of active (non-cancelled) party members. 1 for solo bookings. */
  partySize: number;
  /** Sum of price_cents for all active members (= fee base when wholePartyFee). */
  partyTotalCents: number;
  /** Mirrors salons.noshow_group_whole_party — true = fee charged on whole party. */
  wholePartyFee: boolean;
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
    .select("id, salon_id, client_name, client_phone, client_email, service_id, price_cents, start_time_utc, created_at, booking_channel, source, group_id, noshow_card_id, deposit_required, deposit_status")
    .eq("id", bookingId)
    .maybeSingle();
  const b = data as Row | null;
  if (!b) return null;

  const salonId = str(b.salon_id);
  const phone = str(b.client_phone).replace(/\D/g, "");
  const groupId = str(b.group_id);
  const startMs = Date.parse(str(b.start_time_utc));
  const createdMs = Date.parse(str(b.created_at));
  const leadTimeHours = Number.isFinite(startMs) && Number.isFinite(createdMs)
    ? Math.max(0, Math.round((startMs - createdMs) / 3_600_000))
    : 0;
  const depositStatus = str(b.deposit_status);

  const [{ data: svc }, { data: salon }, stats, { data: profile }, provider, groupResult] = await Promise.all([
    b.service_id ? db.from("services").select("name").eq("id", str(b.service_id)).maybeSingle() : Promise.resolve({ data: null }),
    db.from("salons").select("vertical, noshow_protection_enabled, noshow_fee_percent, feature_flags, default_notification_locale, noshow_group_whole_party").eq("id", salonId).maybeSingle(),
    // Salon-scoped visit history from BOOKINGS — the client_profiles table is a
    // GLOBAL identity table (no salon_id), so the old .eq("salon_id") filter
    // matched nothing and made every customer look brand-new (→ the agent
    // over-asked cards from loyal clean-record regulars). Mirror the rule's
    // priorBookingStats: non-cancelled bookings at THIS salon for this phone.
    phone.length >= 8
      ? db.from("bookings").select("status").eq("salon_id", salonId).eq("client_phone", phone).not("id", "eq", str(b.id)).not("status", "eq", "cancelled").limit(50)
      : Promise.resolve({ data: [] }),
    // is_vip is a global per-customer attribute → look up by phone only.
    phone.length >= 8
      ? db.from("client_profiles").select("is_vip").eq("phone", phone).maybeSingle()
      : Promise.resolve({ data: null }),
    resolvePaymentProvider(salonId),
    // Group booking: fetch all members so the agent sees the whole-party fee base.
    // Mirrors the noShowBaseCents() logic in square/noshow.ts (PR #586).
    groupId
      ? db.from("bookings").select("price_cents, status")
        .eq("salon_id", salonId).eq("group_id", groupId)
      : Promise.resolve({ data: [] }),
  ]);

  const s = (salon as Row | null) ?? {};
  const historyRows = (stats.data ?? []) as Row[];
  const visitCount = historyRows.length;
  const noShowCount = historyRows.filter((r) => str(r.status) === "no_show").length;
  const p = (profile as Row | null) ?? {};

  // Group context: mirrors noShowBaseCents() so the AI reasons on the real fee base.
  const wholePartyFee = s.noshow_group_whole_party !== false;
  const groupRows = ((groupResult.data ?? []) as Row[]).filter((r) => str(r.status) !== "cancelled");
  const isGroupBooking = Boolean(groupId) && groupRows.length > 1;
  const partySize = isGroupBooking ? groupRows.length : 1;
  const partyTotalCents = isGroupBooking && wholePartyFee
    ? groupRows.reduce((sum, r) => sum + num(r.price_cents), 0)
    : num(b.price_cents);

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
    hasCardOnFile: str(b.noshow_card_id).trim().length > 0,
    hasActiveDeposit:
      ["required", "pending", "held", "paid"].includes(depositStatus) ||
      (b.deposit_required === true && !depositStatus),
    leadTimeHours,
    isNew: visitCount <= 0,
    visitCount,
    noShowCount,
    isVip: p.is_vip === true,
    vertical: str(s.vertical) || "nail salon",
    protectionEnabled: s.noshow_protection_enabled === true,
    providerConnected: Boolean(provider),
    defaultFeePercent: num(s.noshow_fee_percent) || 20,
    maxFeePercent: 50,
    aiShadowEnabled:
      (s.feature_flags as Record<string, unknown> | null)?.ai_noshow_policy_shadow === true,
    aiLiveEnabled:
      (s.feature_flags as Record<string, unknown> | null)?.ai_noshow_policy_live === true,
    ruleFirstOptimizationEnabled: ruleFirstOptimizationEnabled(
      s.feature_flags as Record<string, unknown> | null,
    ),
    // Salon's primary language for customer-facing messages. Falls back to "en"
    // (Hi-Lite's guests are English; Vietnamese-first salons set this to "vi").
    language: str(s.default_notification_locale).startsWith("vi") ? "vi" : "en",
    isGroupBooking,
    partySize,
    partyTotalCents,
    wholePartyFee,
  };
}

export type SaveCardMessages = { sms: string; email: string };

/**
 * AI-drafts the customer-facing "save a card to hold your spot" message at SEND
 * time, in the CUSTOMER's language (not always Vietnamese — Hi-Lite's guests are
 * English). Two channels with different constraints:
 *  - sms: ONE short line, no emoji, no link (the caller appends the real URL),
 *    Twilio/A2P-friendly. Hard-clamped by guardSmsLine downstream.
 *  - email: a couple of warm sentences (the email template wraps the CTA + link).
 * Returns null on any failure → caller falls back to its fixed template.
 */
export async function draftSaveCardMessages(input: {
  salonId: string;
  lang: "en" | "vi";
  salonName: string;
  clientName?: string | null;
  serviceName?: string | null;
}): Promise<SaveCardMessages | null> {
  const ai = getClient();
  if (!ai) return null;

  const langLabel = input.lang === "vi" ? "tiếng Việt" : "English";
  const who = (input.clientName ?? "").trim() || (input.lang === "vi" ? "khách" : "the guest");
  const svc = (input.serviceName ?? "").trim();
  const prompt = `Write two short, warm, professional appointment messages in ${langLabel} for a salon customer.

Context: ${who} booked${svc ? ` "${svc}"` : ""} at ${input.salonName}. We ask them to save a card on file to hold the appointment — there is NO upfront charge; they are only charged a fee if they no-show.

Rules:
- "sms": ONE single line, MAX 200 characters, NO emojis, NO links/URLs (a link is appended automatically), MUST include the salon name "${input.salonName}", friendly + transactional.
- "email": 1-2 warm sentences, NO emojis, NO links, NO greeting line — just explain that saving a card holds their spot with no upfront charge, only charged on a no-show.

Return ONLY JSON: {"sms":"<message>","email":"<message>"}`;

  try {
    const model = "claude-haiku-4-5-20251001";
    const resp = await trackAnthropicMessage(
      { salonId: input.salonId, feature: "noshow_save_card_message", model },
      () =>
        ai.messages.create({
          model,
          max_tokens: 300,
          messages: [{ role: "user", content: prompt }],
        }),
    );
    const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as Partial<SaveCardMessages>;
    const sms = typeof parsed.sms === "string" ? parsed.sms.trim() : "";
    const email = typeof parsed.email === "string" ? parsed.email.trim() : "";
    if (!sms && !email) return null;
    return { sms, email };
  } catch {
    return null;
  }
}

/**
 * Deterministic SMS guard (the spine for the AI-drafted SMS). Enforces Twilio /
 * A2P hygiene: collapse whitespace to one line, strip emojis + any model-invented
 * links, require the salon name, clamp length, then append the REAL url. Returns
 * null when the text is empty/too long → caller uses its fixed template. */
export function guardSmsLine(text: string, salonName: string, url: string): string | null {
  let t = (text || "").replace(/\s+/g, " ").trim();
  // Strip emoji / pictographs (keep letters incl. diacritics, digits, punctuation).
  t = t
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  // Remove any URL the model wrote — we control the link.
  t = t.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 280) return null;
  // Brand identification (A2P): ensure the salon name is present.
  if (!t.toLowerCase().includes(salonName.toLowerCase())) t = `${salonName}: ${t}`;
  return `${t} ${url}`;
}

/** ① AI BRAIN — decide the protection + draft the ask. Returns null on failure. */
export async function agentDecideNoShowPolicy(ctx: PolicyContext): Promise<AiPolicyDecision | null> {
  const ai = getClient();
  if (!ai) return null;

  const isVi = ctx.language === "vi";
  const locale = isVi ? "vi-VN" : "en-US";
  const when = new Date(ctx.startTimeUtc).toLocaleString(locale, { timeZone: "America/Los_Angeles" });

  // Build prompt in the salon's primary language so the customer-facing message
  // (the "reason" and "message" fields) comes out in the right tongue.
  // English path: Hi-Lite and other EN-primary salons get an English prompt.
  // Vietnamese path: VN salons keep the original warm Vietnamese framing.
  const groupLineVi = ctx.isGroupBooking
    ? `- Đặt nhóm: ${ctx.partySize} người${ctx.wholePartyFee ? `, tổng giá trị đoàn ~$${(ctx.partyTotalCents / 100).toFixed(0)} (phí no-show tính toàn bộ đoàn, KHÔNG phải chỉ slot này)` : ""}.`
    : "";
  const groupLineEn = ctx.isGroupBooking
    ? `- Group booking: party of ${ctx.partySize}${ctx.wholePartyFee ? `, total party value ~$${(ctx.partyTotalCents / 100).toFixed(0)} (no-show fee applies to the WHOLE party, not just this slot)` : ""}.`
    : "";

  const prompt = isVi
    ? `Bạn là quản lý phụ trách chính sách chống no-show cho một ${ctx.vertical}. Quyết định mức bảo vệ cho lượt hẹn này một cách LINH HOẠT và NHÂN VĂN (giữ trải nghiệm cao cấp cho khách quen, chặt với rủi ro thật), KHÔNG máy móc theo ngưỡng.

Lựa chọn được hệ thống hỗ trợ:
- "none": tin khách, không đòi gì.
- "card": yêu cầu lưu thẻ (chỉ bị trừ phí nếu thật sự vắng).

Bối cảnh:
- Khách: ${ctx.isNew ? "KHÁCH MỚI" : `quay lại, đã đến ${ctx.visitCount} lần`} | số lần no-show trước: ${ctx.noShowCount} | VIP: ${ctx.isVip}
- Liên hệ: ${ctx.hasPhone ? "có SĐT" : "KHÔNG SĐT"}, ${ctx.hasEmail ? "có email" : "không email"}
- Lượt hẹn: ${ctx.serviceName}, giá slot ~$${(ctx.priceCents / 100).toFixed(0)}, lúc ${when}, đặt trước ${ctx.leadTimeHours} giờ, kênh ${ctx.channel}
${groupLineVi}- Tiệm: bảo vệ no-show ${ctx.protectionEnabled ? "BẬT" : "TẮT"}, cổng thanh toán ${ctx.providerConnected ? "đã nối" : "CHƯA nối"}, phí mặc định ${ctx.defaultFeePercent}%.

Không tự thay đổi phần trăm phí; hệ thống luôn dùng đúng mức ${ctx.defaultFeePercent}% do salon cấu hình.
Nếu chọn card, soạn 1 lời nhắn ngắn, ấm áp, lịch sự cho khách bằng tiếng Việt (xưng hô thân thiện).

Chỉ trả JSON: {"protection":"none|card","reason":"<1 câu tiếng Việt vì sao>","message":"<lời nhắn hoặc null>","confidence":"low|medium|high"}`
    : `You are the no-show policy manager for a ${ctx.vertical}. Decide protection for this appointment FLEXIBLY and HUMANELY (preserve a premium experience for loyal regulars, be firm for real risks), NOT by rigid thresholds.

Options:
- "none": trust the customer, require nothing.
- "card": require a card on file (only charged on a confirmed no-show).

Context:
- Customer: ${ctx.isNew ? "NEW CUSTOMER" : `returning, ${ctx.visitCount} visit(s)`} | prior no-shows: ${ctx.noShowCount} | VIP: ${ctx.isVip}
- Contact: ${ctx.hasPhone ? "has phone" : "NO PHONE"}, ${ctx.hasEmail ? "has email" : "no email"}
- Appointment: ${ctx.serviceName}, slot price ~$${(ctx.priceCents / 100).toFixed(0)}, at ${when}, booked ${ctx.leadTimeHours} hour(s) ahead, channel: ${ctx.channel}
${groupLineEn}- Salon: no-show protection ${ctx.protectionEnabled ? "ON" : "OFF"}, payment gateway ${ctx.providerConnected ? "connected" : "NOT connected"}, default fee ${ctx.defaultFeePercent}%.

Do not change the fee percentage; the system always uses the salon-configured ${ctx.defaultFeePercent}%.
If card is selected, write a short, warm, professional message to the customer in English.

Return ONLY JSON: {"protection":"none|card","reason":"<1 sentence reason>","message":"<message or null>","confidence":"low|medium|high"}`;

  try {
    const model = "claude-haiku-4-5-20251001";
    const resp = await trackAnthropicMessage(
      { salonId: ctx.salonId, feature: "noshow_policy", model },
      () => ai.messages.create({
        model,
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    );
    const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as Partial<AiPolicyDecision>;
    const protection: Protection = parsed.protection === "card" ? "card" : "none";
    return {
      protection,
      feePercent: protection === "card" ? ctx.defaultFeePercent : 0,
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

  // Deposit decisions are not executed by this agent. Fail closed to the
  // deterministic path instead of pretending a deposit was created.
  if (ai.protection === "deposit") return null;

  // A booking that already has a card or active deposit is protected. Asking
  // again adds friction and caused nearly every production disagreement found
  // in the 2026-08 audit.
  if (ctx.hasCardOnFile || ctx.hasActiveDeposit) {
    return {
      protection: "none",
      feePercent: 0,
      reason: `${ai.reason} (booking đã được bảo vệ → không yêu cầu lại)`,
      message: null,
      confidence: ai.confidence,
    };
  }

  // Can only ask for money when a provider is connected + protection is on.
  if (ai.protection === "card" && (!ctx.providerConnected || !ctx.protectionEnabled)) {
    return { protection: "none", feePercent: 0, reason: `${ai.reason} (cổng/bảo vệ chưa sẵn → không đòi)`, message: null, confidence: ai.confidence };
  }
  // VIP courtesy guard (kept conservative for v1).
  if (ctx.isVip && ai.protection !== "none") {
    return { protection: "none", feePercent: 0, reason: `${ai.reason} (VIP → giữ ưu ái, không đòi)`, message: null, confidence: ai.confidence };
  }
  // The model never sets money policy. Use only the owner-configured percentage.
  const feePercent = ai.protection === "none"
    ? 0
    : Math.min(
        ctx.maxFeePercent,
        Math.max(0, Math.round(ctx.defaultFeePercent)),
      );
  return { ...ai, feePercent };
}

/** A model may add protection only with high confidence and may not remove a
 * deterministic card requirement until outcome calibration proves that doing
 * so is safe. This keeps the AI useful at the uncertain edge without letting a
 * prompt variation weaken an owner's configured policy. */
export function guardPolicyDelta(
  ai: AiPolicyDecision | null,
  ruleProtection: Protection,
): AiPolicyDecision | null {
  if (!ai) return null;
  if (ruleProtection === "card" && ai.protection === "none") return null;
  if (ai.protection !== ruleProtection && ai.confidence !== "high") return null;
  return ai;
}

export function isNoShowPolicyAmbiguous(ctx: PolicyContext): boolean {
  if (
    ctx.isVip ||
    ctx.hasCardOnFile ||
    ctx.hasActiveDeposit ||
    !ctx.protectionEnabled ||
    !ctx.providerConnected
  ) return false;
  const { score } = deterministicNoShowRiskScore({
    salonId: ctx.salonId,
    clientName: ctx.clientName,
    serviceName: ctx.serviceName,
    startTimeUtc: ctx.startTimeUtc,
    isNewCustomer: ctx.isNew,
    visitCount: ctx.visitCount,
    noShowCount: ctx.noShowCount,
    bookingSource: ctx.channel,
    hasEmail: ctx.hasEmail,
    hasPhone: ctx.hasPhone,
  });
  return score >= 50 && score < 70;
}

/**
 * Run the agent for one booking and LOG the decision vs the rule.
 *
 * - SHADOW (ai_noshow_policy_shadow): log only, `applied=false`, returns null →
 *   the caller keeps the deterministic rule. Zero effect.
 * - LIVE (ai_noshow_policy_live): the guarded decision DRIVES the card flag.
 *   Returns `{ cardRequired }` so an in-flight caller (evaluateBookingNoShow)
 *   applies it in its own update; when `applyToRow` is set (cron backfill, no
 *   surrounding update) it also writes `noshow_card_required` directly.
 *
 * The AI still NEVER charges — live only sets the "needs a card on file" flag;
 * the actual charge stays manual + consent-gated + idempotent downstream. If the
 * guarded decision is unusable (low confidence / AI down / unsafe), live falls
 * back to the rule (returns null). Best-effort; never throws.
 */
export async function runNoShowPolicyAgent(
  bookingId: string,
  opts: { applyToRow?: boolean } = {},
): Promise<{ cardRequired: boolean } | null> {
  try {
    let ctx = await gatherPolicyContext(bookingId);
    if (!ctx) return null;
    if (!ctx.aiShadowEnabled && !ctx.aiLiveEnabled) return null; // not opted in

    // In live mode, carry forward an already-authorized returning card before
    // asking AI. Shadow stays strictly log-only. The operation is idempotent,
    // never charges, and gives every booking channel the same protection state.
    if (ctx.aiLiveEnabled && !ctx.hasCardOnFile && !ctx.hasActiveDeposit) {
      try {
        const { autoAttachReturningCard } = await import(
          "@/shared/integrations/square/noshow"
        );
        const carried = await autoAttachReturningCard(bookingId);
        if (carried.attached) {
          ctx = (await gatherPolicyContext(bookingId)) ?? ctx;
        }
      } catch {
        /* best-effort; deterministic fallback below remains authoritative */
      }
    }

    // Existing card/deposit protection is already the desired outcome. Avoid
    // spending AI credit and, in live mode, return an authoritative guarded
    // decision so callers do not run a second card/deposit mechanism.
    if (ctx.hasCardOnFile || ctx.hasActiveDeposit) {
      const livePermissionStillEnabled =
        ctx.aiLiveEnabled &&
        (await isAiAgentPermissionEnabled(
          ctx.salonId,
          "ai_noshow_policy_live",
        ));
      if (!livePermissionStillEnabled) return null;

      if (opts.applyToRow) {
        const db = createServiceRoleClient();
        await db
          .from("bookings" as never)
          .update({ noshow_card_required: false } as never)
          .eq("id", bookingId);
      }
      return { cardRequired: false };
    }

    // What the current deterministic rule would do (card vs none).
    let ruleProtection: Protection = "none";
    try {
      const { noShowCardDecision } = await import("@/shared/integrations/square/noshow");
      if ((await noShowCardDecision(bookingId)).required) ruleProtection = "card";
    } catch {
      /* leave as none */
    }

    if (ctx.ruleFirstOptimizationEnabled) {
      if (!isNoShowPolicyAmbiguous(ctx)) return null;
      const claimed = await claimAiExecutionSlot({
        salonId: ctx.salonId,
        feature: "noshow_policy",
        dedupeKey: bookingId,
        windowSeconds: 3600,
        maxCalls: 20,
      });
      if (!claimed) return null;
    }

    const aiRaw = await agentDecideNoShowPolicy(ctx);
    const ai = guardPolicyDelta(
      clampAndGuard(aiRaw, ctx),
      ruleProtection,
    );

    // The model call can outlive an owner's permission change. Re-read the
    // sensitive live-policy flag before allowing either the caller or this
    // backfill path to change the booking. If live was the only mode and was
    // revoked, discard the stale result entirely instead of mislabeling it as
    // a shadow decision.
    const livePermissionStillEnabled =
      ctx.aiLiveEnabled &&
      (await isAiAgentPermissionEnabled(
        ctx.salonId,
        "ai_noshow_policy_live",
      ));
    if (
      ctx.aiLiveEnabled &&
      !livePermissionStillEnabled &&
      !ctx.aiShadowEnabled
    ) {
      return null;
    }

    // LIVE only when fresh permission exists AND we have a usable decision.
    const live = livePermissionStillEnabled && ai != null;
    const cardRequired = ai?.protection === "card";

    const db = createServiceRoleClient();
    await db.from("ai_policy_decisions" as never).insert({
      salon_id: ctx.salonId,
      booking_id: bookingId,
      agent: "noshow_policy",
      mode: live ? "live" : "shadow",
      ai_protection: ai?.protection ?? "none",
      ai_fee_percent: ai?.feePercent ?? null,
      ai_reason: ai?.reason ?? (aiRaw ? "(bị guard chặn)" : "(AI không phản hồi → dùng rule)"),
      ai_message: ai?.message ?? null,
      ai_confidence: ai?.confidence ?? null,
      rule_protection: ruleProtection,
      applied: live,
    } as never);

    if (!live) return null; // shadow (or guard fell back) → caller keeps the rule

    // Apply directly when the caller has no surrounding write (cron backfill).
    if (opts.applyToRow) {
      await db
        .from("bookings" as never)
        .update({ noshow_card_required: cardRequired } as never)
        .eq("id", bookingId);
    }
    return { cardRequired };
  } catch (e) {
    console.error("[runNoShowPolicyAgent]", e);
    return null;
  }
}

/**
 * Backfill agent decisions for a salon's EXISTING upcoming bookings — most
 * Hi-Lite bookings arrive via the Square sync (not the NailIQ online flow), so
 * the per-booking hook never fires for them. Called from the square-sync cron
 * (prod, where ANTHROPIC_API_KEY exists). Self-gated on the salon's opt-in flag
 * (shadow OR live); caps the AI calls per run so the log fills steadily. In LIVE
 * mode it writes the card flag directly (applyToRow). Best-effort.
 */
export async function backfillNoShowShadow(salonId: string, cap = 5): Promise<void> {
  try {
    const db = looseServiceClient();
    const { data: salon } = await db.from("salons").select("feature_flags").eq("id", salonId).maybeSingle();
    const flags = (salon as Row | null)?.feature_flags as Record<string, unknown> | null;
    const shadowOn = flags?.ai_noshow_policy_shadow === true;
    const liveOn = flags?.ai_noshow_policy_live === true;
    if (!shadowOn && !liveOn) return;

    // In LIVE mode, "already handled" means a booking already has a LIVE/override
    // decision — a booking that only has a SHADOW row is upgraded to live once
    // (so flipping the salon to live actually governs the upcoming book, not just
    // bookings created afterward). In shadow-only mode, any prior row counts.
    const decQuery = db.from("ai_policy_decisions").select("booking_id, mode").eq("salon_id", salonId);
    const { data: done } = await (liveOn
      ? decQuery.in("mode", ["live", "override"])
      : decQuery
    ).limit(1000);
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
      const decision = await runNoShowPolicyAgent(id, { applyToRow: liveOn });
      if (liveOn && !decision) {
        const { ensureNoShowCardRequirement } = await import(
          "@/shared/noshow/ensureNoShowCardRequirement"
        );
        await ensureNoShowCardRequirement(id);
      }
      ran++;
    }
  } catch (e) {
    console.error("[backfillNoShowShadow]", e);
    throw e;
  }
}
