export const AI_AGENT_FLAG_KEYS = [
  "ai_noshow_policy_live",
  "ai_watchdog",
  "ai_winback",
  "ai_rebook",
  "ai_smart_reminders",
  "ai_social_content",
  "ai_vip_care",
  "ai_first_visit_nurture",
  "ai_unified_digest",
  "ai_gbp_post",
  "ai_yelp_reply",
] as const;

export type AiAgentFlagKey = (typeof AI_AGENT_FLAG_KEYS)[number];

export type AiAgentFlags = Record<AiAgentFlagKey, boolean>;

export type AiAgentImpact =
  | "booking_policy"
  | "customer_outreach"
  | "owner_notification"
  | "draft_only"
  | "monitoring";

export const AI_AGENT_IMPACT: Record<AiAgentFlagKey, AiAgentImpact> = {
  ai_noshow_policy_live: "booking_policy",
  ai_watchdog: "monitoring",
  ai_winback: "customer_outreach",
  ai_rebook: "customer_outreach",
  ai_smart_reminders: "customer_outreach",
  ai_social_content: "draft_only",
  ai_vip_care: "customer_outreach",
  ai_first_visit_nurture: "customer_outreach",
  ai_unified_digest: "owner_notification",
  ai_gbp_post: "draft_only",
  ai_yelp_reply: "draft_only",
};

export const AI_AGENT_DISPLAY_NAME: Record<AiAgentFlagKey, string> = {
  ai_noshow_policy_live: "Người Gác Cửa — No-show Guard",
  ai_watchdog: "Người Canh Tiệm — Watchdog",
  ai_winback: "Người Kéo Về — Win-back",
  ai_rebook: "Người Đặt Lại — Rebook",
  ai_smart_reminders: "Người Nhắc Lịch — Smart Reminders",
  ai_social_content: "Người Làm Nội Dung — Social Content",
  ai_vip_care: "Người Chăm VIP — VIP Care",
  ai_first_visit_nurture: "Người Chăm Khách Mới — First Visit",
  ai_unified_digest: "Người Báo Cáo — Daily Digest",
  ai_gbp_post: "Người Đăng Google — GBP Post",
  ai_yelp_reply: "Người Trả Lời Yelp — Yelp Reply",
};

export const AI_AGENT_IMPACT_LABEL: Record<AiAgentImpact, string> = {
  booking_policy: "Có thể thay đổi chính sách đặt lịch",
  customer_outreach: "Có thể liên hệ trực tiếp với khách",
  owner_notification: "Chỉ gửi thông báo vận hành cho chủ tiệm",
  draft_only: "Chỉ tạo bản nháp, không tự đăng hoặc gửi",
  monitoring: "Chỉ theo dõi và tạo cảnh báo",
};

export function isAiAgentFlagKey(value: unknown): value is AiAgentFlagKey {
  return (
    typeof value === "string" &&
    (AI_AGENT_FLAG_KEYS as readonly string[]).includes(value)
  );
}

export function requiresAiAgentEnableAcknowledgement(
  flagKey: AiAgentFlagKey,
): boolean {
  const impact = AI_AGENT_IMPACT[flagKey];
  return impact === "customer_outreach" || impact === "booking_policy";
}
