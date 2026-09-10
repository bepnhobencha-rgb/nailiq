/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");
const { readReports, conclusion, details } = require("./lib/playwright-reports.cjs");

const result = readReports(path.resolve(process.argv[2] || "playwright-report"));
const c = result.counts;
process.stdout.write([
  "### Playwright results", "",
  `Read ${result.reports.length} JSON reports: ${result.reports.join(", ") || "none"}.`,
  "Counts cover these reports only, including repeated executions; passed means the declared expectation was met.", "",
  "| Total | Passed | Failed | Flaky | Skipped | Interrupted | Unknown |",
  "| ----: | -----: | -----: | ----: | ------: | ----------: | ------: |",
  `| ${c.total} | ${c.passed} | ${c.failed} | ${c.flaky} | ${c.skipped} | ${c.interrupted} | ${c.unknown} |`, "",
  `> ${conclusion(result)}`, "", ...details(result), "",
].join("\n"));
