import { describe, expect, it } from "vitest";

import { summarizeManagerRun } from "@/shared/ai/managerRunSummary";

describe("summarizeManagerRun", () => {
  it("does not count intentional digest skips as successful sends or failures", () => {
    expect(summarizeManagerRun([
      { salon: "alpha", digest: "skipped_feature_disabled" },
      { salon: "beta", digest: "skipped_already_sent" },
      { salon: "gamma", digest: "skipped_notifications_disabled" },
      { salon: "delta", digest: "skipped_unknown" },
    ])).toEqual({
      salons: 4, agent_runs: 1, agent_failures: 1,
      failed_agents: ["delta:digest"],
    });
  });
  it("counts successful and failed agent runs without storing error bodies", () => {
    expect(
      summarizeManagerRun([
        { salon: "alpha", watchdog: "ok", winback: "boom secret details" },
        { salon: "beta", digest: "ok" },
      ]),
    ).toEqual({
      salons: 2,
      agent_runs: 3,
      agent_failures: 1,
      failed_agents: ["alpha:winback"],
    });
  });

  it("reports an idle manager run honestly", () => {
    expect(summarizeManagerRun([])).toEqual({
      salons: 0,
      agent_runs: 0,
      agent_failures: 0,
      failed_agents: [],
    });
  });
});
