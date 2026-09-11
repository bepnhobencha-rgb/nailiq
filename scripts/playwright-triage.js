/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");
const { readReports, conclusion, details } = require("./lib/playwright-reports.cjs");

const result = readReports(path.resolve(process.argv[2] || "playwright-reports"), { shards: true });
const c = result.counts;
process.stdout.write([
  `Read ${result.reports.length} JSON reports across downloaded shard directories.`,
  `Reported executions: ${c.total}; passed: ${c.passed}; failed: ${c.failed}; flaky: ${c.flaky}; skipped: ${c.skipped}; interrupted: ${c.interrupted}; unknown: ${c.unknown}.`,
  conclusion(result), ...details(result), "",
].join("\n"));
