export type ManagerRunSummary = {
  salons: number;
  agent_runs: number;
  agent_failures: number;
  failed_agents: string[];
};

export function summarizeManagerRun(
  results: Array<Record<string, unknown>>,
): ManagerRunSummary {
  const failedAgents: string[] = [];
  let agentRuns = 0;

  for (const result of results) {
    const salon = String(result.salon ?? "unknown");
    for (const [agent, outcome] of Object.entries(result)) {
      if (agent === "salon") continue;
      agentRuns++;
      if (outcome !== "ok") failedAgents.push(`${salon}:${agent}`);
    }
  }

  return {
    salons: results.length,
    agent_runs: agentRuns,
    agent_failures: failedAgents.length,
    failed_agents: failedAgents.slice(0, 100),
  };
}
