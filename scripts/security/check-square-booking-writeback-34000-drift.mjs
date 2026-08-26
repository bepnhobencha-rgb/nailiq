#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const VERSION = "20260823034000";
const EXPECTED_SHA256 =
  "c22af53b10769a9deeee81e22dbed945c26cb76a1f5d353fd09bb401988b97cb";
const EXPECTED_BYTES = 28_803;
const EXPECTED_STATEMENTS = 15;
const migrationPath = path.join(
  process.cwd(),
  "supabase/migrations/20260823034000_add_durable_square_booking_writeback.sql",
);

const file = readFileSync(migrationPath);
const fileHash = createHash("sha256").update(file).digest("hex");
if (file.length !== EXPECTED_BYTES || fileHash !== EXPECTED_SHA256) {
  throw new Error(
    `frozen migration ${VERSION} drifted: bytes=${file.length} sha256=${fileHash}`,
  );
}

if (process.argv.includes("--file-only")) {
  process.stdout.write(
    `PASS ${VERSION} file bytes=${file.length} sha256=${fileHash}\n`,
  );
  process.exit(0);
}

const urlIndex = process.argv.indexOf("--db-url");
const dbUrl = urlIndex >= 0
  ? process.argv[urlIndex + 1]
  : "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
if (!dbUrl) throw new Error("--db-url requires a value");

const query = `
SELECT
  encode(
    extensions.digest(
      convert_to(array_to_string(statements, E';\\n') || E';\\n', 'UTF8'),
      'sha256'
    ),
    'hex'
  ),
  cardinality(statements),
  octet_length(convert_to(array_to_string(statements, E';\\n') || E';\\n', 'UTF8'))
FROM supabase_migrations.schema_migrations
WHERE version = '${VERSION}';
`;
const result = spawnSync(
  "psql",
  [dbUrl, "-AtX", "-v", "ON_ERROR_STOP=1", "-c", query],
  { encoding: "utf8" },
);
if (result.status !== 0) {
  throw new Error(
    `unable to read local migration history: ${result.stderr.trim() || "psql failed"}`,
  );
}

const [dbHash, statementCountText, dbBytesText] = result.stdout.trim().split("|");
const statementCount = Number(statementCountText);
const dbBytes = Number(dbBytesText);
if (
  dbHash !== fileHash
  || statementCount !== EXPECTED_STATEMENTS
  || dbBytes !== file.length
) {
  throw new Error(
    `migration history drift: file=${fileHash}/${file.length} db=${dbHash}/${dbBytes} statements=${statementCount}`,
  );
}

process.stdout.write(
  `PASS ${VERSION} file=database sha256=${fileHash} bytes=${file.length} statements=${statementCount}\n`,
);
