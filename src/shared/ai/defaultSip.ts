import type { SalonIntelligenceProfile } from "./types";

/**
 * Fallback SIP (Salon Intelligence Profile) built from existing salon fields
 * until the Manager Briefing wizard is completed (P1).
 *
 * Once a salon has gone through the briefing, their ai_profile column is set
 * and this function just returns it. Until then, we derive safe defaults so
 * every salon gets consistent AI behaviour out-of-the-box.
 */
export function defaultSip(salon: {
  ai_profile?: SalonIntelligenceProfile | null;
  language?: string | null;
}): SalonIntelligenceProfile {
  if (salon.ai_profile) return salon.ai_profile;
  return {
    vertical: "nail",
    brand_voice: "warm_professional",
    language_primary: (salon.language as "en" | "vi" | "zh" | "ko") ?? "en",
    noshow_strictness: "moderate",
    contact_window: "9:00-20:00",
    winback_cadence: "normal",
    primary_goal: "retain_regulars",
    auto_approve: ["send_reminders", "send_winback"],
    escalate: ["charge_card", "change_price", "review_response_bad"],
    tone_examples: [],
    built_at: new Date().toISOString(),
    built_via: "manager_briefing",
  };
}
