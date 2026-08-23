import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/ci.yml"),
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
});
