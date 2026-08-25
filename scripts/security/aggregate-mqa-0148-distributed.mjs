#!/usr/bin/env node

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

function requiredArgument(index, label) {
  const value = process.argv[index]?.trim();
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function walkJsonFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walkJsonFiles(path));
    else if (entry.endsWith(".json")) files.push(path);
  }
  return files;
}

function percentileNearestRank(samples, percentile) {
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1] ?? 0;
}

const inputDirectory = resolve(requiredArgument(2, "artifact directory"));
const stage = Number(requiredArgument(3, "stage"));
const candidateSha = requiredArgument(4, "candidate SHA");
const outputFile = resolve(requiredArgument(5, "output file"));

if (![250, 500].includes(stage) || !/^[a-f0-9]{40}$/.test(candidateSha)) {
  throw new Error("REFUSE: aggregate identity mismatch");
}

const files = walkJsonFiles(inputDirectory).filter((file) =>
  basename(file).startsWith(`mqa-0148-${stage}-shard-`),
);
if (files.length !== 10) {
  throw new Error(`expected 10 source receipts, found ${files.length}`);
}

const shards = files.map((file) => JSON.parse(readFileSync(file, "utf8")));
const shardIndexes = shards.map((shard) => shard.shardIndex).sort((a, b) => a - b);
if (
  shards.some(
    (shard) =>
      shard.mqaId !== "MQA-0148" ||
      shard.serverMode !== "vercel-preview-distributed" ||
      shard.candidateSha !== candidateSha ||
      shard.stage !== stage ||
      shard.shardCount !== 10,
  ) ||
  shardIndexes.some((index, expected) => index !== expected)
) {
  throw new Error("source receipt identity mismatch");
}

const results = shards.flatMap((shard) => shard.results);
const globalIndexes = results.map((result) => result.globalIndex).sort((a, b) => a - b);
if (
  results.length !== stage ||
  globalIndexes.some((index, expected) => index !== expected)
) {
  throw new Error("distributed request coverage is incomplete or duplicated");
}

const releases = shards.map((shard) => shard.releasedAtMs);
const releaseSpreadMs = Math.max(...releases) - Math.min(...releases);
const failures = results.filter(
  (result) =>
    !result.ok ||
    result.status !== 200 ||
    result.redirectedToLogin ||
    !result.correctTenant ||
    result.error,
);
const samples = results.map((result) => result.elapsedMs);
const summary = {
  requests: results.length,
  publicBooking: results.filter((result) => result.kind === "booking").length,
  dashboard: results.filter((result) => result.kind === "dashboard").length,
  failures: failures.length,
  p95Ms: percentileNearestRank(samples, 0.95),
  maxMs: Math.max(...samples),
  releaseSpreadMs,
};
const passed =
  summary.publicBooking === Math.round(stage * 0.7) &&
  summary.dashboard === stage - Math.round(stage * 0.7) &&
  summary.failures === 0 &&
  summary.p95Ms < 10_000 &&
  summary.maxMs < 20_000 &&
  summary.releaseSpreadMs <= 5_000;

const receipt = {
  result: passed ? "PASS" : "FAIL",
  mqaId: "MQA-0148",
  serverMode: "vercel-preview-distributed",
  candidateSha,
  stage,
  thresholds: {
    failedRequests: 0,
    p95MsExclusive: 10_000,
    maxMsExclusive: 20_000,
    releaseSpreadMsInclusive: 5_000,
  },
  githubRunIds: [...new Set(shards.map((shard) => shard.githubRunId))],
  summary,
  failures: failures.slice(0, 50),
};
writeFileSync(outputFile, `${JSON.stringify(receipt, null, 2)}\n`, {
  mode: 0o600,
});
process.stdout.write(`[MQA-0148-AGGREGATE] ${JSON.stringify(receipt)}\n`);
if (!passed) process.exitCode = 1;
