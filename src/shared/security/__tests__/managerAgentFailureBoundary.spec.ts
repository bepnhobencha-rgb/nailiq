import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const managedAgents = [
  ["src/shared/ai/agentCancellationRadar.ts", "[runCancellationRadar]", "runCancellationRadar"],
  ["src/shared/ai/agentRevenue.ts", "[runRevenueReport]", "runRevenueReport"],
  ["src/shared/ai/agentStaffPerformance.ts", "[runStaffPerformance]", "runStaffPerformance"],
  ["src/shared/noshow/agentNoShowPolicy.ts", "[backfillNoShowShadow]", "backfillNoShowShadow"],
  ["src/shared/watchdog/agentWatchdog.ts", "[runWatchdog]", "runWatchdog"],
  ["src/shared/winback/agentWinback.ts", "[runWinback]", "runWinback"],
  ["src/shared/winback/agentRebook.ts", "[runRebook]", "runRebook"],
  ["src/shared/ai/agentDailyReport.ts", "[agentDailyReport]", "runDailyReport"],
  ["src/shared/ai/agentDigest.ts", "[runDigest]", "runDigest"],
  ["src/shared/ai/agentSocialContent.ts", "[runSocialContent]", "runSocialContent"],
  ["src/shared/ai/agentVipCare.ts", "[runVipCare]", "runVipCare"],
  ["src/shared/ai/agentStrategist.ts", "[runStrategist]", "runStrategist"],
  ["src/shared/ai/agentReviewResponder.ts", "[runReviewResponder]", "runReviewResponder"],
  ["src/shared/ai/agentYelpResponder.ts", "[runYelpResponder]", "runYelpResponder"],
  ["src/shared/ai/agentGoogleBusinessPost.ts", "[runGbpPost]", "runGbpPost"],
  ["src/shared/firstvisit/agentFirstVisit.ts", "[runFirstVisitNurture]", "runFirstVisitNurture"],
] as const;

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("AI Manager agent failure boundary", () => {
  it.each(managedAgents)(
    "%s logs and rethrows unexpected top-level failures",
    (file, logLabel) => {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source).toMatch(
        new RegExp(
          `console\\.error\\("${escapeRegExp(logLabel)}"[^;]*;\\s*throw e;`,
        ),
      );
    },
  );

  it("keeps the boundary list attached to the Manager orchestration", () => {
    const route = readFileSync(
      resolve(process.cwd(), "src/app/api/cron/manager/route.ts"),
      "utf8",
    );

    for (const [, , functionName] of managedAgents) {
      expect(route).toContain(`await ${functionName}(salon.id`);
    }
  });
});
