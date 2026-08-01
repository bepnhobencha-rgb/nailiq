import { describe, expect, it } from "vitest";

import { summarizeManagerRun } from "@/shared/ai/managerRunSummary";

describe("summarizeManagerRun", () => {
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
