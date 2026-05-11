// Emits a one-line GitHub-Actions step summary derived from
// playwright-report/results.json. Tolerant of a missing or partial
// report (e.g. when the test run was cancelled before any result
// was written) — prints a clear placeholder instead of crashing.
const fs = require("fs");
const path = require("path");

const reportPath = path.resolve(
  process.cwd(),
  "playwright-report/results.json",
);

function tallyFromSuites(suites, acc) {
  if (!Array.isArray(suites)) return;
  for (const suite of suites) {
    if (Array.isArray(suite.specs)) {
      for (const spec of suite.specs) {
        for (const test of spec.tests ?? []) {
          const last = test.results?.[test.results.length - 1];
          const status = last?.status ?? "unknown";
          acc.total += 1;
          if (status === "passed") acc.passed += 1;
          else if (status === "failed" || status === "timedOut")
            acc.failed += 1;
          else if (status === "skipped") acc.skipped += 1;
          else if (status === "flaky") acc.flaky += 1;
          else acc.other += 1;
        }
      }
    }
    tallyFromSuites(suite.suites, acc);
  }
}

function main() {
  if (!fs.existsSync(reportPath)) {
    process.stdout.write(
      "### Playwright results\n\n_No `playwright-report/results.json` found — the run may have been cancelled before any spec finished._\n",
    );
    return;
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (err) {
    process.stdout.write(
      `### Playwright results\n\n_Could not parse results.json: ${
        err instanceof Error ? err.message : String(err)
      }_\n`,
    );
    return;
  }

  const acc = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    flaky: 0,
    other: 0,
  };
  tallyFromSuites(report.suites, acc);

  const duration = report.stats?.duration
    ? `${(report.stats.duration / 1000).toFixed(1)}s`
    : "—";

  const lines = [
    "### Playwright results",
    "",
    "| Total | Passed | Failed | Skipped | Flaky | Duration |",
    "| ----: | -----: | -----: | ------: | ----: | -------: |",
    `| ${acc.total} | ${acc.passed} | ${acc.failed} | ${acc.skipped} | ${acc.flaky} | ${duration} |`,
    "",
  ];

  if (acc.failed > 0) {
    lines.push(
      `> ${acc.failed} failure${acc.failed === 1 ? "" : "s"} — see the **playwright-report** artifact for the HTML report.`,
    );
  } else if (acc.total === 0) {
    lines.push("> No tests ran.");
  } else {
    lines.push("> All executed specs passed.");
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

main();
