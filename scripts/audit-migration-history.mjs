#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const FOLDED_BASELINE_VERSION = "20260723000000";
const migrationsDir = path.join(root, "supabase", "migrations");
const ledgerPath = path.join(
  root,
  "supabase",
  "migration-history",
  "production-ledger-2026-07-23.json",
);

function parseFilename(filename) {
  const match = /^(\d{14})_(.+)\.sql$/.exec(filename);
  if (!match) {
    throw new Error(`Invalid migration filename: ${filename}`);
  }
  return { version: match[1], name: match[2], filename };
}

function groupBy(items, key) {
  const grouped = new Map();
  for (const item of items) {
    const value = item[key];
    const bucket = grouped.get(value) ?? [];
    bucket.push(item);
    grouped.set(value, bucket);
  }
  return grouped;
}

async function main() {
  const local = (await readdir(migrationsDir))
    .filter((filename) => filename.endsWith(".sql"))
    .sort()
    .map(parseFilename);

  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  if (ledger.rowCount !== ledger.migrations.length) {
    throw new Error(
      `Ledger rowCount is ${ledger.rowCount}, but it contains ${ledger.migrations.length} rows`,
    );
  }

  const localByVersion = groupBy(local, "version");
  const remoteByVersion = groupBy(ledger.migrations, "version");
  const localByName = groupBy(local, "name");

  const duplicateVersions = [...localByVersion.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([version, files]) => ({
      version,
      files: files.map(({ filename }) => filename),
    }));

  const localOnly = [...localByVersion.keys()].filter(
    (version) => !remoteByVersion.has(version),
  );
  const remoteOnly = [...remoteByVersion.keys()].filter(
    (version) => !localByVersion.has(version),
  );
  const exactMatches = [...localByVersion.keys()].filter((version) =>
    remoteByVersion.has(version),
  );
  const renamedMatches = ledger.migrations.filter((remote) => {
    const localFiles = localByName.get(remote.name) ?? [];
    return localFiles.some((file) => file.version !== remote.version);
  });

  const result = {
    releaseSha: ledger.releaseSha,
    localFiles: local.length,
    localUniqueVersions: localByVersion.size,
    productionRows: ledger.migrations.length,
    exactMatches: exactMatches.length,
    localOnlyUniqueVersions: localOnly.length,
    productionOnlyVersions: remoteOnly.length,
    duplicateVersionIds: duplicateVersions.length,
    extraFilesBehindDuplicateIds: duplicateVersions.reduce(
      (sum, duplicate) => sum + duplicate.files.length - 1,
      0,
    ),
    sameNameDifferentVersion: renamedMatches.length,
    localOnlyVersions: localOnly,
  };

  console.log(JSON.stringify(result, null, 2));

  if (process.argv.includes("--cutover-ready")) {
    const cutoverReady =
      local.length === ledger.migrations.length + 1 &&
      localByVersion.size === local.length &&
      duplicateVersions.length === 0 &&
      exactMatches.length === ledger.migrations.length &&
      remoteOnly.length === 0 &&
      localOnly.length === 1 &&
      localOnly[0] === FOLDED_BASELINE_VERSION;

    if (!cutoverReady) {
      console.error(
        "Folded cutover invariant failed: expected every production version plus only the folded baseline.",
      );
      process.exitCode = 1;
    }
  }

  if (process.argv.includes("--strict")) {
    const drifted =
      duplicateVersions.length > 0 ||
      localOnly.length > 0 ||
      remoteOnly.length > 0;
    if (drifted) {
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
