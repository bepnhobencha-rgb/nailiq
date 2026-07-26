#!/usr/bin/env node

import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const BASELINE_VERSION = "20260723000000";
const BASELINE_NAME = "folded_production_schema_baseline";
const LEGACY_MIGRATIONS_DIR = path.join(
  "supabase",
  "migration-history",
  "legacy-2026-07-23",
);
const POST_SNAPSHOT_FILES = [
  "20260716010000_sms_agent_sessions.sql",
  "20260719010000_tax_presets_rls.sql",
  "20260720010000_owner_notification_log.sql",
  "20260720120000_voice_session_tool_log.sql",
  "20260721010000_voice_session_lang_es.sql",
  "20260721032930_nail_tryon_foundation.sql",
  "20260721034942_nail_tryon_generation_fields.sql",
  "20260721072707_nail_tryon_telemetry_retention.sql",
  "20260721090000_voice_ai_upsell.sql",
  "20260722011000_nail_design_multi_service_mapping.sql",
  "20260722063820_add_self_service_trial.sql",
  "20260722175728_move_cron_auth_to_vault.sql",
  "20260722180738_lock_internal_rpc_execution.sql",
  "20260722182513_harden_public_booking_addons.sql",
  "20260722184158_lock_verification_rpcs.sql",
  "20260722184711_secure_function_default_privileges.sql",
  "20260722184850_secure_global_function_defaults.sql",
  "20260722193542_rate_limit_public_booking.sql",
  "20260722195941_block_anon_direct_booking_insert.sql",
  "20260722201500_harden_public_group_booking.sql",
  "20260722203000_bind_client_snapshot_to_booking.sql",
  "20260722205000_close_public_pii_reads.sql",
  "20260722210600_close_loyalty_otp_reads.sql",
  "20260722214100_harden_public_salon_reads.sql",
  "20260722221300_isolate_authenticated_salon_reads.sql",
  "20260722223100_harden_public_staff_catalog.sql",
];
const PRODUCTION_STATE_ONLY_FILES = new Set([
  "20260722175728_move_cron_auth_to_vault.sql",
]);
const POST_SNAPSHOT_SERVICE_ROLE_GRANT_TABLES = [
  "owner_notification_log",
  "sms_agent_sessions",
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

function stripTrailingWhitespace(sql) {
  return sql.replace(/[ \t]+$/gm, "");
}

function scanDollarQuotes(line, openTag) {
  const tokens = line.match(/\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/g);
  if (!tokens) return openTag;

  let tag = openTag;
  for (const token of tokens) {
    if (tag === null) tag = token;
    else if (token === tag) tag = null;
  }
  return tag;
}

function removeTopLevelDataStatements(sql) {
  const output = [];
  let dollarTag = null;
  let skipping = false;
  let removed = 0;

  for (const line of sql.split("\n")) {
    const wasInsideDollarBody = dollarTag !== null;
    dollarTag = scanDollarQuotes(line, dollarTag);

    if (skipping) {
      if (dollarTag === null && /;\s*(?:--.*)?$/.test(line)) {
        skipping = false;
      }
      continue;
    }

    if (
      !wasInsideDollarBody &&
      /^\s*(?:INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|COPY\s+)/i.test(line)
    ) {
      removed += 1;
      skipping = !(dollarTag === null && /;\s*(?:--.*)?$/.test(line));
      continue;
    }

    output.push(line);
  }

  if (skipping || dollarTag !== null) {
    throw new Error("Unterminated SQL while removing post-snapshot data statements");
  }

  return { sql: output.join("\n"), removed };
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

  const baseline = ledger.migrations.find(
    (migration) => migration.version === BASELINE_VERSION,
  );
  if (!baseline || baseline.name !== BASELINE_NAME) {
    throw new Error(
      `Production ledger must contain ${BASELINE_VERSION}_${BASELINE_NAME}`,
    );
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
  const markerMigrations = ledger.migrations.filter(
    (migration) => migration.version !== BASELINE_VERSION,
  );
  const ledgerVersions = new Set(
    ledger.migrations.map((migration) => migration.version),
  );
  const latestProductionVersion = [...ledgerVersions].sort().at(-1);
  if (!latestProductionVersion) {
    throw new Error("Production ledger is empty");
  }
  const forwardMigrations = (await readdir(liveMigrationsDir))
    .filter((filename) => filename.endsWith(".sql"))
    .sort()
    .map((filename) => {
      const match = /^(\d{14})_([A-Za-z0-9_]+)\.sql$/.exec(filename);
      if (!match) {
        throw new Error(`Invalid migration filename: ${filename}`);
      }
      return { filename, version: match[1] };
    })
    .filter(({ version }) => !ledgerVersions.has(version));

  const invalidForwardMigration = forwardMigrations.find(
    ({ version }) => version <= latestProductionVersion,
  );
  if (invalidForwardMigration) {
    throw new Error(
      `Migration not represented by the production ledger must be newer than the latest production version: ${invalidForwardMigration.filename}`,
    );
  }

  await mkdir(outputDir, { recursive: true });

  for (const migration of markerMigrations) {
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
    POST_SNAPSHOT_FILES.map(async (filename) => {
      const source = await readFile(
        path.join(root, LEGACY_MIGRATIONS_DIR, filename),
        "utf8",
      );
      if (PRODUCTION_STATE_ONLY_FILES.has(filename)) {
        if (/^\s*(?:create|alter|drop|grant|revoke)\b/im.test(source)) {
          throw new Error(
            `Production-state-only migration unexpectedly contains top-level DDL: ${filename}`,
          );
        }
        return { filename, sql: "", removed: 0, omitted: true };
      }
      const sanitized = removeTopLevelDataStatements(
        source,
      );
      return { filename, ...sanitized, omitted: false };
    }),
  );
  const removedDataStatements = deltas.reduce(
    (total, delta) => total + delta.removed,
    0,
  );
  if (removedDataStatements !== 3) {
    throw new Error(
      `Expected to remove 3 top-level data statements, removed ${removedDataStatements}`,
    );
  }

  const baseline = stripTrailingWhitespace([
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
    ...deltas.flatMap(({ filename, sql, omitted }) =>
      omitted
        ? [
            `-- OMITTED production-state-only delta: ${filename}`,
            "-- Its cron/Vault credential transition is not part of a blank schema baseline.",
            "",
          ]
        : [
            `-- BEGIN post-snapshot schema delta: ${filename}`,
            sql.trim(),
            `-- END post-snapshot schema delta: ${filename}`,
            "",
          ],
    ),
    "-- BEGIN folded-baseline grant reconciliation",
    "-- These post-snapshot tables inherited production's service_role default",
    "-- privileges. The schema snapshot strips ALTER DEFAULT PRIVILEGES, so the",
    "-- equivalent table grants must be explicit in a blank database.",
    `GRANT ALL ON TABLE ${POST_SNAPSHOT_SERVICE_ROLE_GRANT_TABLES.map((table) => `public.${table}`).join(", ")} TO service_role;`,
    "-- END folded-baseline grant reconciliation",
    "",
  ].join("\n"));

  await writeFile(
    path.join(outputDir, `${BASELINE_VERSION}_${BASELINE_NAME}.sql`),
    `${baseline.trim()}\n`,
    { flag: "wx" },
  );

  for (const migration of forwardMigrations) {
    await copyFile(
      path.join(liveMigrationsDir, migration.filename),
      path.join(outputDir, migration.filename),
    );
  }

  console.log(
    JSON.stringify(
      {
        outputDir,
        markerMigrations: markerMigrations.length,
        baselineVersion: BASELINE_VERSION,
        postSnapshotSchemaDeltas:
          POST_SNAPSHOT_FILES.length - PRODUCTION_STATE_ONLY_FILES.size,
        omittedProductionStateDeltas: [...PRODUCTION_STATE_ONLY_FILES],
        reconciledServiceRoleGrantTables:
          POST_SNAPSHOT_SERVICE_ROLE_GRANT_TABLES,
        forwardMigrations: forwardMigrations.map(({ filename }) => filename),
        totalMigrations:
          markerMigrations.length + 1 + forwardMigrations.length,
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
