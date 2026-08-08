import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const COVERAGE: ReadonlyArray<{
  file: string;
  features: readonly string[];
}> = [
  { file: "src/shared/ai/agentDailyReport.ts", features: ["daily_report"] },
  { file: "src/shared/ai/agentDigest.ts", features: ["digest"] },
  { file: "src/shared/ai/agentGoogleBusinessPost.ts", features: ["gbp_post"] },
  { file: "src/shared/ai/agentRevenue.ts", features: ["revenue_report"] },
  { file: "src/shared/ai/agentReviewResponder.ts", features: ["review_responder"] },
  { file: "src/shared/ai/agentSocialContent.ts", features: ["social_content"] },
  { file: "src/shared/ai/agentStaffPerformance.ts", features: ["staff_performance"] },
  { file: "src/shared/ai/agentStrategist.ts", features: ["strategist"] },
  { file: "src/shared/ai/agentVipCare.ts", features: ["vip_care_draft"] },
  { file: "src/shared/ai/agentYelpResponder.ts", features: ["yelp_responder"] },
  { file: "src/shared/firstvisit/agentFirstVisit.ts", features: ["first_visit_draft"] },
  {
    file: "src/shared/noshow/agentNoShowPolicy.ts",
    features: ["noshow_save_card_message", "noshow_policy"],
  },
  { file: "src/shared/noshow/sendReminderEmail.ts", features: ["reminder_email"] },
  { file: "src/shared/reminders/agentSmartReminder.ts", features: ["smart_reminder"] },
  { file: "src/shared/watchdog/agentWatchdog.ts", features: ["watchdog"] },
  { file: "src/shared/winback/agentRebook.ts", features: ["rebook_draft"] },
  { file: "src/shared/winback/agentWinback.ts", features: ["winback_draft"] },
];

describe("AI Agent cost-ledger boundary", () => {
  for (const entry of COVERAGE) {
    it(`tracks every Anthropic call in ${entry.file}`, () => {
      const source = readFileSync(join(process.cwd(), entry.file), "utf8");
      const rawCalls = source.match(/\.messages\.create\s*\(/g)?.length ?? 0;
      const trackedCalls = source.match(/trackAnthropicMessage\s*\(/g)?.length ?? 0;

      expect(rawCalls).toBeGreaterThan(0);
      expect(trackedCalls).toBe(rawCalls);
      for (const feature of entry.features) {
        expect(source).toContain(`feature: "${feature}"`);
      }
    });
  }
});
