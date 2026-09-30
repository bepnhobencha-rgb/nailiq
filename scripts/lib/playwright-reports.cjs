/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { stripVTControlCharacters } = require("node:util");

function text(value, limit = 300) {
  return stripVTControlCharacters(String(value ?? ""))
    .replace(/\s+/g, " ").replaceAll("`", "'").slice(0, limit);
}

function message(error) {
  return text(error?.message ?? error?.value ?? "No error message recorded");
}

// Flaky belongs to the test outcome, not an attempt's status. Respect declared
// expected failures as well as ordinary passing tests.
function outcome(test) {
  if (test.status === "skipped") return "skipped";
  const last = test.results?.at(-1);
  if (!last || !last.status) return "unknown";
  if (last.status === "interrupted") return "interrupted";
  if (test.status === "flaky") return "flaky";
  if (test.status === "unexpected") return "failed";
  if (test.status === "expected") return "passed";
  return "unknown";
}

function readReports(root, { shards = false } = {}) {
  const result = {
    reports: [], issues: [], errors: [], tests: [],
    counts: { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, interrupted: 0, unknown: 0 },
  };
  const relative = (file) => text(path.relative(root, file) || ".");
  function entries(directory) {
    try {
      return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      result.issues.push(`${relative(directory)}: report directory unavailable`);
      return [];
    }
  }
  function walk(suites, report, parents = []) {
    if (!Array.isArray(suites)) {
      result.issues.push(`${report}: invalid suites`);
      return;
    }
    for (const suite of suites) {
      if (!suite || typeof suite !== "object" || !Array.isArray(suite.specs)) {
        result.issues.push(`${report}: invalid suite`);
        continue;
      }
      const titles = [...parents, suite.title].filter(Boolean);
      for (const spec of suite.specs) {
        if (!spec || !Array.isArray(spec.tests)) {
          result.issues.push(`${report}: invalid spec`);
          continue;
        }
        for (const test of spec.tests) {
          if (!test || !Array.isArray(test.results)) {
            result.issues.push(`${report}: invalid test results`);
            continue;
          }
          const status = outcome(test);
          const last = test.results.at(-1);
          const failedAttempt = test.results.find((attempt) =>
            attempt && ["failed", "timedOut", "interrupted"].includes(attempt.status));
          const errorAttempt = status === "flaky" ? failedAttempt : last;
          result.tests.push({
            report, status,
            title: text([...titles, spec.title].filter(Boolean).join(" > ")),
            project: text(test.projectName || test.projectId || "unknown project", 80),
            error: message(errorAttempt?.error ?? errorAttempt?.errors?.[0]),
          });
          result.counts.total += 1;
          result.counts[status] += 1;
        }
      }
      if (suite.suites !== undefined) walk(suite.suites, report, titles);
    }
  }
  function readDirectory(directory) {
    // Read only reporter outputs at the artifact root, not HTML data, trace
    // attachments or copied reports that would count an execution twice.
    const files = entries(directory).filter((entry) => entry.isFile() &&
      (entry.name === "results.json" || entry.name.endsWith("-results.json")));
    if (!files.some((entry) => entry.name === "results.json")) {
      result.issues.push(`${relative(directory)}: primary results.json missing`);
    }
    for (const file of files) {
      const filename = path.join(directory, file.name);
      const report = relative(filename);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filename, "utf8"));
      } catch {
        // Parse errors can quote payload fragments. Name the file, not its contents.
        result.issues.push(`${report}: unreadable or invalid JSON`);
        continue;
      }
      if (!data || !Array.isArray(data.suites) || !Array.isArray(data.errors)) {
        result.issues.push(`${report}: invalid Playwright report`);
        continue;
      }
      result.reports.push(report);
      for (const error of data.errors) result.errors.push({ report, error: message(error) });
      walk(data.suites, report);
    }
  }
  if (shards) {
    const directories = entries(root).filter((entry) =>
      entry.isDirectory() && /^playwright-report-shard-\d+$/.test(entry.name));
    if (directories.length === 0) result.issues.push("No shard report directories found");
    for (const directory of directories) readDirectory(path.join(root, directory.name));
  } else {
    readDirectory(root);
  }
  return result;
}

function conclusion(result) {
  const c = result.counts;
  if (result.issues.length || c.interrupted || c.unknown) return "Incomplete evidence; do not infer a passing run.";
  if (result.errors.length || c.failed) return "Failures recorded; inspect the reports and workflow logs.";
  if (c.flaky) return "Flaky tests recorded; retry success is not a clean pass.";
  if (c.total === 0) return "No tests reported; do not infer a passing run.";
  if (c.total === c.skipped) return "Only skipped tests reported; no executed pass evidence.";
  return "All reported executions met their expectations; this does not certify the whole workflow.";
}

function details(result, limit = 10) {
  const lines = [];
  const groups = [
    ["Unexpected failures", result.tests.filter((test) => test.status === "failed")],
    ["Flaky tests (passed only after retry)", result.tests.filter((test) => test.status === "flaky")],
    ["Interrupted or unknown tests", result.tests.filter((test) => ["interrupted", "unknown"].includes(test.status))],
    ["Runner errors", result.errors],
  ];
  for (const [label, items] of groups) {
    if (!items.length) continue;
    lines.push(`${label}: ${items.length} (showing ${Math.min(limit, items.length)})`);
    for (const item of items.slice(0, limit)) {
      lines.push(`- ${item.report}${item.title ? ` [${item.project}] ${item.title}` : ""} :: ${item.error}`);
    }
  }
  if (result.issues.length) {
    lines.push(`Report issues: ${result.issues.length} (showing ${Math.min(limit, result.issues.length)})`);
    lines.push(...result.issues.slice(0, limit).map((issue) => `- ${issue}`));
  }
  return lines;
}

module.exports = { readReports, conclusion, details };
