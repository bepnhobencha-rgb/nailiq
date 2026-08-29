/**
 * Per-salon Cancellation / No-Show / Deposit policy. Admin-editable (stored on
 * salons.cancellation_policy as { en, vi }); when a salon hasn't written its own,
 * a coherent bilingual DEFAULT is used so the policy page + booking consent are
 * never blank. The default is a TEMPLATE — salons (and their lawyer) should
 * review/customise it; it is not legal advice.
 */

export type PolicyLang = "en" | "vi";

export type StoredPolicy = { en?: string; vi?: string } | null | undefined;

const POLICY_PLACEHOLDER = /\[[^\]]+\]/;

export type PolicyReadiness = {
  ready: boolean;
  reasons: Array<
    | "missing_english"
    | "missing_vietnamese"
    | "english_placeholder"
    | "vietnamese_placeholder"
  >;
};

/**
 * A salon may display the built-in template while setting up, but the template
 * is not charge-ready.  Money-related protection can only be enabled after the
 * salon has supplied both language versions and removed every bracketed
 * placeholder.  This is deliberately deterministic so UI and server gates can
 * explain the same result.
 */
export function evaluatePolicyReadiness(stored: StoredPolicy): PolicyReadiness {
  const en = stored && typeof stored === "object" ? stored.en?.trim() ?? "" : "";
  const vi = stored && typeof stored === "object" ? stored.vi?.trim() ?? "" : "";
  const reasons: PolicyReadiness["reasons"] = [];
  if (!en) reasons.push("missing_english");
  if (!vi) reasons.push("missing_vietnamese");
  if (en && POLICY_PLACEHOLDER.test(en)) reasons.push("english_placeholder");
  if (vi && POLICY_PLACEHOLDER.test(vi)) reasons.push("vietnamese_placeholder");
  return { ready: reasons.length === 0, reasons };
}

/** A sensible bilingual default. Kept plain text (rendered with line breaks) so
 *  a non-technical salon owner can edit it. */
export function defaultPolicy(lang: PolicyLang, salonName: string): string {
  const s = salonName || (lang === "vi" ? "tiệm" : "the salon");
  if (lang === "vi") {
    return [
      `Chính sách huỷ lịch & vắng mặt — ${s}`,
      ``,
      `1. Đặt lịch: Khi đặt, bạn đồng ý với chính sách này.`,
      `2. Huỷ / đổi lịch: Vui lòng báo trước ít nhất [24 giờ] để huỷ hoặc đổi lịch.`,
      `3. Vắng mặt (no-show): Nếu bạn không đến mà không báo trước, ${s} có thể thu phí vắng mặt là [X% giá dịch vụ].`,
      `4. Đặt cọc: Với một số lịch hẹn, ${s} có thể yêu cầu đặt cọc để giữ chỗ. Tiền cọc sẽ được trừ vào hoá đơn khi bạn đến; nếu vắng mặt, tiền cọc có thể không được hoàn theo chính sách này.`,
      `5. Lưu thẻ: Nếu bạn cho phép lưu thẻ, bạn đồng ý để ${s} chỉ trừ phí vắng mặt nêu trên khi bạn không đến. Bạn có thể gỡ thẻ bất cứ lúc nào.`,
      `6. Hoàn tiền: Mọi yêu cầu hoàn tiền vui lòng liên hệ trực tiếp ${s}.`,
      ``,
      `[Salon vui lòng cập nhật các mục trong ngoặc và nhờ luật sư duyệt.]`,
    ].join("\n");
  }
  return [
    `Cancellation & No-Show Policy — ${s}`,
    ``,
    `1. Booking: By booking, you agree to this policy.`,
    `2. Cancellation / reschedule: Please give at least [24 hours] notice to cancel or reschedule.`,
    `3. No-show: If you miss your appointment without notice, ${s} may charge a no-show fee of [X% of the service price].`,
    `4. Deposit: For some appointments, ${s} may require a deposit to hold the slot. The deposit is applied to your bill when you attend; if you no-show, the deposit may be non-refundable under this policy.`,
    `5. Card on file: If you allow your card to be saved, you authorize ${s} to charge ONLY the no-show fee above if you don't show up. You may remove your card at any time.`,
    `6. Refunds: For any refund request, please contact ${s} directly.`,
    ``,
    `[Salon: please update the bracketed items and have a lawyer review.]`,
  ].join("\n");
}

/** The effective policy text for a salon in a language: custom if set, else
 *  the bilingual default. */
export function resolvePolicy(stored: StoredPolicy, lang: PolicyLang, salonName: string): string {
  const custom = stored && typeof stored === "object" ? stored[lang]?.trim() : "";
  return custom && custom.length > 0 ? custom : defaultPolicy(lang, salonName);
}

/** Short snapshot stored as consent evidence (which policy the customer agreed
 *  to, when). Kept compact — the full text is reproducible from the version. */
export function policyEvidence(stored: StoredPolicy, salonName: string): {
  en: string;
  vi: string;
  capturedAt: string;
} {
  return {
    en: resolvePolicy(stored, "en", salonName),
    vi: resolvePolicy(stored, "vi", salonName),
    capturedAt: new Date().toISOString(),
  };
}
