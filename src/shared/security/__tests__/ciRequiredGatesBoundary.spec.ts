import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/ci.yml"),
  "utf8",
);
const e2eWorkflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/e2e.yml"),
  "utf8",
);
const migrationWorkflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/migration-history-rehearsal.yml"),
  "utf8",
);
const productionGuardCli = readFileSync(
  resolve(process.cwd(), "scripts/assert-e2e-not-production.ts"),
  "utf8",
);

function step(name: string, nextName: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  const end = workflow.indexOf(`- name: ${nextName}`, start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

describe("MQA-0224/0225 required CI gates", () => {
  it("fails the build job when lint fails", () => {
    const lint = step("Lint", "Build");

    expect(lint).toContain("run: npm run lint");
    expect(lint).not.toContain("continue-on-error");
  });

  it("fails the security job on high-severity dependency findings", () => {
    const audit = step("npm audit (high severity)", "Check for committed secrets");

    expect(audit).toContain("run: npm audit --audit-level=high");
    expect(audit).not.toContain("continue-on-error");
  });

  it("loads the production guard through a real TS entrypoint in every Supabase CI preflight", () => {
    const command = "npx tsx scripts/assert-e2e-not-production.ts";
    const invocationCount =
      e2eWorkflow.split(command).length - 1 +
      migrationWorkflow.split(command).length - 1;

    expect(invocationCount).toBe(4);
    expect(e2eWorkflow).not.toContain("import('./e2e/helpers/guardProduction')");
    expect(migrationWorkflow).not.toContain("import('./e2e/helpers/guardProduction')");
    expect(productionGuardCli).toContain(
      'import { assertNotProductionFromEnv } from "../e2e/helpers/guardProduction";',
    );
    expect(productionGuardCli).toContain("assertNotProductionFromEnv();");
  });

  it("uses the PostgreSQL 17 client for the PostgreSQL 17 backup rehearsal", () => {
    expect(migrationWorkflow).toContain(
      "sudo apt-get install -y postgresql-client-17",
    );
    expect(migrationWorkflow).toContain(
      "test -x /usr/lib/postgresql/17/bin/pg_dump",
    );
    expect(migrationWorkflow).toContain(
      'echo "/usr/lib/postgresql/17/bin" >> "$GITHUB_PATH"',
    );
  });
});
