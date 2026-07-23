#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const BASELINE_VERSION = "20260723000000";
const BASELINE_NAME = "folded_production_schema_baseline";
const DELTA_FILES = [
  "20260722210600_close_loyalty_otp_reads.sql",
  "20260722214100_harden_public_salon_reads.sql",
  "20260722221300_isolate_authenticated_salon_reads.sql",
  "20260722223100_harden_public_staff_catalog.sql",
];

function argumentValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function removePsqlOnlyStatements(sql) {
  return sql
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("\\restrict ") &&
        !line.startsWith("\\unrestrict ") &&
        !line.startsWith("ALTER DEFAULT PRIVILEGES "),
    )
    .join("\n");
}

function assertLedger(ledger) {
  if (
    ledger.rowCount !== ledger.migrations.length ||
    ledger.migrations.length === 0
  ) {
    throw new Error("Production ledger row count is invalid");
  }

  const versions = new Set();
  for (const migration of ledger.migrations) {
    if (!/^\d{14}$/.test(migration.version)) {
      throw new Error(`Invalid production version: ${migration.version}`);
    }
    if (!/^[A-Za-z0-9_]+$/.test(migration.name)) {
      throw new Error(`Unsafe production migration name: ${migration.name}`);
    }
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate production version: ${migration.version}`);
    }
    versions.add(migration.version);
  }

  if (versions.has(BASELINE_VERSION)) {
    throw new Error(`Baseline version ${BASELINE_VERSION} already exists`);
  }
}

async function main() {
  const root = process.cwd();
  const outputArg = argumentValue("--output");
  if (!outputArg) {
    throw new Error("Usage: node scripts/build-folded-migration-history.mjs --output <directory>");
  }

  const outputDir = path.resolve(root, outputArg);
  const liveMigrationsDir = path.resolve(root, "supabase", "migrations");
  if (outputDir === liveMigrationsDir) {
    throw new Error(
      "Refusing to replace supabase/migrations. Generate into a throwaway directory for rehearsal.",
    );
  }

  const ledgerPath = path.join(
    root,
    "supabase",
    "migration-history",
    "production-ledger-2026-07-23.json",
  );
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assertLedger(ledger);

  await mkdir(outputDir, { recursive: true });

  for (const migration of ledger.migrations) {
    const marker = [
      `-- Folded-history marker for production migration ${migration.version}.`,
      `-- Original production name: ${migration.name}.`,
      "-- Its schema effect is represented by the later folded baseline.",
      "",
    ].join("\n");
    await writeFile(
      path.join(outputDir, `${migration.version}_${migration.name}.sql`),
      marker,
      { flag: "wx" },
    );
  }

  const prelude = await readFile(
    path.join(root, "supabase", "bootstrap", "prelude.sql"),
    "utf8",
  );
  const schema = removePsqlOnlyStatements(
    await readFile(
      path.join(root, "supabase", "bootstrap", "schema.sql"),
      "utf8",
    ),
  );
  const deltas = await Promise.all(
    DELTA_FILES.map(async (filename) => ({
      filename,
      sql: await readFile(
        path.join(root, "supabase", "migrations", filename),
        "utf8",
      ),
    })),
  );

  const baseline = [
    "-- Generated folded schema baseline. Never execute this migration on the",
    "-- existing production schema; production must record its version through",
    "-- a separately approved migration-history repair after rehearsal.",
    "",
    "-- BEGIN bootstrap prelude",
    prelude.trim(),
    "-- END bootstrap prelude",
    "",
    "-- BEGIN verified schema-only production snapshot",
    schema.trim(),
    "-- END verified schema-only production snapshot",
    "",
    ...deltas.flatMap(({ filename, sql }) => [
      `-- BEGIN post-snapshot security delta: ${filename}`,
      sql.trim(),
      `-- END post-snapshot security delta: ${filename}`,
      "",
    ]),
  ].join("\n");

  await writeFile(
    path.join(outputDir, `${BASELINE_VERSION}_${BASELINE_NAME}.sql`),
    `${baseline.trim()}\n`,
    { flag: "wx" },
  );

  console.log(
    JSON.stringify(
      {
        outputDir,
        markerMigrations: ledger.migrations.length,
        baselineVersion: BASELINE_VERSION,
        totalMigrations: ledger.migrations.length + 1,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
