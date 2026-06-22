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
] as const;

export type AiAgentFlagKey = (typeof AI_AGENT_FLAG_KEYS)[number];

export type AiAgentFlags = Record<AiAgentFlagKey, boolean>;
