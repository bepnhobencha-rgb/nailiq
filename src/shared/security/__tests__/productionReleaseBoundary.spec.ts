import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("production release and incident boundary", () => {
  it("does not auto-deploy main before the database release gate is complete", () => {
    const manifest = JSON.parse(read("vercel.json")) as {
      git?: { deploymentEnabled?: Record<string, boolean> };
    };

    expect(manifest.git?.deploymentEnabled?.main).toBe(false);
  });

  it("keeps a manual alert-to-recovery incident drill available", () => {
    const workflow = read(".github/workflows/production-monitoring.yml");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("simulate_failure:");
    expect(workflow).toContain("issues: write");
    expect(workflow).toContain("Open or update incident");
    expect(workflow).toContain("Close recovered incident");
  });

  it("documents schema-first release and both rollback branches", () => {
    const runbook = read("docs/GO-LIVE-RUNBOOK.md");

    const schema = runbook.indexOf("RELEASE-2 — Apply schema first");
    const probe = runbook.indexOf("RELEASE-3 — Verify schema and behavior");
    const deploy = runbook.indexOf("RELEASE-4 — Deploy the application");
    const canary = runbook.indexOf("RELEASE-5 — Run read-only canaries");

    expect(schema).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(schema);
    expect(deploy).toBeGreaterThan(probe);
    expect(canary).toBeGreaterThan(deploy);
    expect(runbook).toContain("ROLLBACK-A — Application regression");
    expect(runbook).toContain("ROLLBACK-B — Schema or compatibility regression");
    expect(runbook).toContain("No customer data, provider mutation, charge, SMS, email or call");
  });
});
