export type SalonIntelligenceProfile = {
  vertical: "nail" | "head_spa" | "massage" | "facial" | "waxing" | "multi";
  brand_voice: "warm_casual" | "warm_professional" | "luxury_formal" | "friendly_fun";
  language_primary: "en" | "vi" | "zh" | "ko";
  language_secondary?: "en" | "vi" | "zh" | "ko";
  customer_demographic?: string;
  noshow_strictness: "lenient" | "moderate" | "strict";
  contact_window: string;
  winback_cadence: "gentle" | "normal" | "aggressive";
  primary_goal: "retain_regulars" | "attract_new" | "maximize_revenue";
  auto_approve: string[];
  escalate: string[];
  tone_examples: string[];
  built_at: string;
  built_via: "manager_briefing" | "settings_change" | "weekly_eval";
};
