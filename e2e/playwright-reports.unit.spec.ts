import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Attempt = { status?: string; error?: { message: string }; retry?: number };
function testRow(status = "expected", results: Attempt[] = [{ status: "passed" }]) {
  return { status, results, expectedStatus: "passed", projectName: "mobile" };
}
function report(tests = [testRow()], title = "Booking", errors: { message: string }[] = []) {
  return {
    errors,
    suites: [{ title: "booking.spec.ts", specs: [{ id: "same-id", title, tests }] }],
  };
}

const summaryScript = resolve("scripts/playwright-summary.js");
const triageScript = resolve("scripts/playwright-triage.js");
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "nailiq-report-unit-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function write(relative: string, data: unknown) {
  const filename = join(root, relative);
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, JSON.stringify(data));
}
function run(script: string, directory = root) {
  const result = spawnSync(process.execPath, [script, directory], { encoding: "utf8", cwd: root });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe("Playwright report completeness", () => {
  it("includes the supplemental failure when the main suite passed", () => {
    write("results.json", report());
    write("booking-submit-webkit-results.json", report([
      testRow("unexpected", [{ status: "failed", error: { message: "booking-success not visible" } }]),
    ], "Complete booking end-to-end"));
    const output = run(summaryScript);
    expect(output).toContain("| 2 | 1 | 1 | 0 | 0 | 0 | 0 |");
    expect(output).toContain("booking-submit-webkit-results.json [mobile]");
    expect(output).toContain("Complete booking end-to-end :: booking-success not visible");
    expect(output).not.toContain("All reported executions met");
  });

  it("aggregates supplemental files across shards without traversing attachments or HTML copies", () => {
    write("playwright-report-shard-1/results.json", report());
    write("playwright-report-shard-1/booking-submit-webkit-results.json", report([
      testRow("unexpected", [{ status: "timedOut" }]),
    ], "Submission"));
    write("playwright-report-shard-2/results.json", report());
    write("playwright-report-shard-1/data/trace-results.json", report());
    write("playwright-report-shard-1/booking-submit-webkit/results.json", report());
    write("next-server-log-shard-1/results.json", report());
    write("playwright-report-shard-1/diagnostics.json", report());
    const output = run(triageScript);
    expect(output).toContain("Read 3 JSON reports");
    expect(output).toContain("executions: 3; passed: 2; failed: 1");
    expect(output).toContain("playwright-report-shard-1/booking-submit-webkit-results.json");
  });

  it("keeps retry history separate from clean passes", () => {
    write("results.json", report([testRow("flaky", [
      { status: "failed", retry: 0, error: { message: "channel not online" } },
      { status: "passed", retry: 1 },
    ])]));
    const output = run(summaryScript);
    expect(output).toContain("| 1 | 0 | 0 | 1 | 0 | 0 | 0 |");
    expect(output).toContain("Flaky tests (passed only after retry): 1");
    expect(output).toContain("channel not online");
    expect(output).not.toContain("All reported executions met");
  });

  it("respects an expected failure and detects an unexpected pass", () => {
    const expectedFailure = { ...testRow("expected", [{ status: "failed" }]), expectedStatus: "failed" };
    const unexpectedPass = { ...testRow("unexpected"), expectedStatus: "failed" };
    write("results.json", report([expectedFailure, unexpectedPass]));
    expect(run(summaryScript)).toContain("| 2 | 1 | 1 | 0 | 0 | 0 | 0 |");
  });

  it("surfaces interrupted and unfinished results without claiming a pass", () => {
    write("results.json", report([
      testRow("unexpected", [{ status: "interrupted" }]),
      testRow("unexpected", []), testRow("unexpected", [{}]),
    ]));
    const output = run(summaryScript);
    expect(output).toContain("| 3 | 0 | 0 | 0 | 0 | 1 | 2 |");
    expect(output).toContain("Incomplete evidence");
  });

  it("includes runner failures even when individual tests passed", () => {
    write("results.json", report([testRow()], "Booking", [{ message: "global teardown failed" }]));
    const output = run(summaryScript);
    expect(output).toContain("Runner errors: 1");
    expect(output).toContain("global teardown failed");
    expect(output).toContain("Failures recorded");
    expect(output).not.toContain("All reported executions met");
  });

  it("warns on malformed supplemental JSON without hiding a valid failure or quoting the payload", () => {
    write("results.json", report([testRow("unexpected", [{ status: "failed" }])]));
    writeFileSync(join(root, "booking-results.json"), '{"privateToken":"do-not-print",');
    const output = run(summaryScript);
    expect(output).toContain("booking-results.json: unreadable or invalid JSON");
    expect(output).toContain("Unexpected failures: 1");
    expect(output).not.toContain("do-not-print");
    expect(output).not.toContain("All reported executions met");
  });

  it("warns when an existing shard lacks its primary report", () => {
    write("playwright-report-shard-1/results.json", report());
    write("playwright-report-shard-2/booking-results.json", report());
    const output = run(triageScript);
    expect(output).toContain("playwright-report-shard-2: primary results.json missing");
    expect(output).toContain("Incomplete evidence");
  });

  it("does not call missing or empty reports a passing run", () => {
    expect(run(summaryScript, join(root, "missing"))).toContain("report directory unavailable");
    expect(run(triageScript)).toContain("No shard report directories found");
    write("results.json", { suites: [], errors: [] });
    expect(run(summaryScript)).toContain("No tests reported");
  });

  it("does not call skipped-only results executed passes", () => {
    write("results.json", report([testRow("skipped", [{ status: "skipped" }])]));
    const output = run(summaryScript);
    expect(output).toContain("| 1 | 0 | 0 | 0 | 1 | 0 | 0 |");
    expect(output).toContain("Only skipped tests reported");
  });

  it("reports invalid nested structures as incomplete evidence", () => {
    write("results.json", report());
    write("broken-results.json", { suites: [{ specs: [{ tests: null }] }], errors: [] });
    write("invalid-results.json", { suites: [], errors: "invalid" });
    const output = run(summaryScript);
    expect(output).toContain("invalid spec");
    expect(output).toContain("invalid Playwright report");
    expect(output).toContain("Incomplete evidence");
  });

  it("counts repeated executions independently even when their spec ids match", () => {
    write("results.json", report([testRow(), testRow(), testRow()]));
    write("repeat-results.json", report([testRow(), testRow()]));
    expect(run(summaryScript)).toContain("| 5 | 5 | 0 | 0 | 0 | 0 | 0 |");
  });

  it("bounds displayed detail, preserves the total, and strips control formatting", () => {
    write("results.json", report(Array.from({ length: 12 }, () => testRow("unexpected", [
      { status: "failed", error: { message: "\u001b[31mfailed\u001b[0m\n```" } },
    ]))));
    const output = run(summaryScript);
    expect(output).toContain("Unexpected failures: 12 (showing 10)");
    expect(output.match(/:: failed/g)).toHaveLength(10);
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("```");
  });

  it("does not traverse symlinked attachments", () => {
    write("results.json", report());
    write("elsewhere/data.json", report([testRow("unexpected", [{ status: "failed" }])]));
    symlinkSync(join(root, "elsewhere/data.json"), join(root, "linked-results.json"));
    expect(run(summaryScript)).toContain("| 1 | 1 | 0 | 0 | 0 | 0 | 0 |");
  });

  it("wires the workflow to the tested local reader", () => {
    const workflow = readFileSync(resolve(".github/workflows/e2e.yml"), "utf8");
    expect(workflow).toContain("node scripts/playwright-triage.js playwright-reports");
    expect(workflow).not.toContain("No failed tests in any shard report.");
  });
});
