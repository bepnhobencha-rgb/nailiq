import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const COVERAGE: ReadonlyArray<{
  file: string;
  features: readonly string[];
  tracker?: "trackAnthropicMessage" | "trackAnthropicStream";
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
  { file: "src/shared/ai/buildSip.ts", features: ["sip_builder"] },
  {
    file: "src/shared/ai/managerBriefingAction.ts",
    features: ["manager_briefing"],
  },
  {
    file: "src/shared/dashboard/loadOwnerPulse.ts",
    features: ["owner_pulse"],
  },
  {
    file: "src/app/api/dashboard/copilot/route.ts",
    features: ["admin_copilot"],
  },
  {
    file: "src/app/api/twilio/sms/route.ts",
    features: ["sms_receptionist"],
  },
  {
    file: "src/shared/observability/triageError.ts",
    features: ["error_triage"],
  },
  {
    file: "src/shared/observability/draftFix.ts",
    features: ["error_fix_file", "error_fix_draft"],
  },
  {
    file: "src/app/api/chat/booking/route.ts",
    features: ["booking_chat"],
    tracker: "trackAnthropicStream",
  },
];

describe("AI Agent cost-ledger boundary", () => {
  for (const entry of COVERAGE) {
    it(`tracks every Anthropic call in ${entry.file}`, () => {
      const source = readFileSync(join(process.cwd(), entry.file), "utf8");
      const rawCalls = source.match(/\.messages\.create\s*\(/g)?.length ?? 0;
      const tracker = entry.tracker ?? "trackAnthropicMessage";
      const trackedCalls = source.match(
        new RegExp(`${tracker}\\s*\\(`, "g"),
      )?.length ?? 0;

      expect(rawCalls).toBeGreaterThan(0);
      expect(trackedCalls).toBe(rawCalls);
      for (const feature of entry.features) {
        expect(source).toContain(`feature: "${feature}"`);
      }
    });
  }
});
