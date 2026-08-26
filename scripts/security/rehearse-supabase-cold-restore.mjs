#!/usr/bin/env node

/**
 * MQA-0192 two-stack, local-only Supabase cold-restore rehearsal.
 *
 * This harness never starts a stack and refuses non-loopback endpoints. The
 * caller must provide two already-running disposable Supabase stacks on
 * independent PostgreSQL clusters. It restores the source logical archive to
 * a temporary database on the target cluster and separately transfers a
 * known-hash Storage object, because pg_dump contains storage metadata but not
 * the object bytes held by the Storage service. SOURCE_STACK_DIR and
 * TARGET_STACK_DIR must point at their distinct local Supabase project roots;
 * CLI status from each root is the independent endpoint/key identity source.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import {
  assertDistinctStackIdentities,
  assertSupabaseStatusMatches,
  readLocalStackIdentity,
  runSupabaseStatus,
  sanitizedCommandEnv,
} from "./local-supabase-status.mjs";

export const COLD_RESTORE_APPROVAL = "RUN_TWO_STACK_LOCAL_ONLY";
export const CANARY_TEXT = "NailIQ MQA-0192 cold restore canary v1\n";
export const CANARY_SHA256 = "401a47f04d17fd61d10a83562af02ddaaca1b6a8e76b72e08bbf8788aa38cd27";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const CRITICAL_ROLES = [
  "anon",
  "authenticated",
  "authenticator",
  "postgres",
  "service_role",
  "supabase_auth_admin",
  "supabase_storage_admin",
];
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const API_TIMEOUT_MS = 5_000;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function postgresMajor(serverVersionNum) {
  const raw = String(serverVersionNum);
  if (!/^\d+$/u.test(raw)) throw new Error("PostgreSQL server_version_num is malformed");
  const numeric = Number(raw);
  if (!Number.isSafeInteger(numeric) || numeric < 90_000) {
    throw new Error("PostgreSQL server_version_num is unsupported");
  }
  if (numeric >= 100_000) return String(Math.floor(numeric / 10_000));
  return `${Math.floor(numeric / 10_000)}.${Math.floor((numeric % 10_000) / 100)}`;
}

function normalizedHost(hostname) {
  return hostname.replace(/^\[(.*)\]$/, "$1");
}

function requireLoopback(url, label) {
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${label} must use an explicit loopback hostname`);
  }
  if (!url.port) throw new Error(`${label} must use an explicit local port`);
}

function parseDatabaseUrl(raw, label) {
  if (!raw) throw new Error(`${label} is required`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL`);
  }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
    throw new Error(`${label} must use PostgreSQL`);
  }
  requireLoopback(url, label);
  if (!url.username || !url.password) throw new Error(`${label} must contain explicit disposable credentials`);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database || new Set(["template0", "template1"]).has(database)) {
    throw new Error(`${label} has an unsafe database name`);
  }
  if (url.search || url.hash) throw new Error(`${label} must not contain query parameters or fragments`);
  return { url, database };
}

function parseApiUrl(raw, label) {
  if (!raw) throw new Error(`${label} is required`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error(`${label} must use HTTP(S)`);
  requireLoopback(url, label);
  if (url.username || url.password || url.search || url.hash || !new Set(["", "/"]).has(url.pathname)) {
    throw new Error(`${label} must be a credential-free API origin`);
  }
  return url;
}

export function canonicalDatabaseTarget(url) {
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  return `${url.protocol}//${normalizedHost(url.hostname)}:${url.port}/${database}`;
}

function canonicalApiTarget(url) {
  return `${url.protocol}//${normalizedHost(url.hostname)}:${url.port}`;
}

export function validateConfig(env) {
  if (env.NAILIQ_COLD_RESTORE_APPROVAL !== COLD_RESTORE_APPROVAL) {
    throw new Error(`Refusing cold restore without NAILIQ_COLD_RESTORE_APPROVAL=${COLD_RESTORE_APPROVAL}`);
  }
  if (env.NAILIQ_DISPOSABLE_SOURCE_STACK !== "1" || env.NAILIQ_DISPOSABLE_TARGET_STACK !== "1") {
    throw new Error("Both disposable-stack opt-ins must equal 1");
  }
  if (env.VERCEL_ENV === "production" || env.VERCEL_TARGET_ENV === "production") {
    throw new Error("Refusing cold restore in a production-marked environment");
  }

  const sourceDb = parseDatabaseUrl(env.SOURCE_DB_URL, "SOURCE_DB_URL");
  const targetDb = parseDatabaseUrl(env.TARGET_DB_URL, "TARGET_DB_URL");
  const sourceApiUrl = parseApiUrl(env.SOURCE_SUPABASE_URL, "SOURCE_SUPABASE_URL");
  const targetApiUrl = parseApiUrl(env.TARGET_SUPABASE_URL, "TARGET_SUPABASE_URL");
  const sourceStackDir = env.SOURCE_STACK_DIR?.trim();
  const targetStackDir = env.TARGET_STACK_DIR?.trim();
  if (!sourceStackDir) throw new Error("SOURCE_STACK_DIR is required");
  if (!targetStackDir) throw new Error("TARGET_STACK_DIR is required");
  const sourceServiceRoleKey = env.SOURCE_SUPABASE_SERVICE_ROLE_KEY;
  const targetServiceRoleKey = env.TARGET_SUPABASE_SERVICE_ROLE_KEY;
  if (!sourceServiceRoleKey || sourceServiceRoleKey.length < 20) {
    throw new Error("SOURCE_SUPABASE_SERVICE_ROLE_KEY is missing or malformed");
  }
  if (!targetServiceRoleKey || targetServiceRoleKey.length < 20) {
    throw new Error("TARGET_SUPABASE_SERVICE_ROLE_KEY is missing or malformed");
  }
  if (canonicalDatabaseTarget(sourceDb.url) === canonicalDatabaseTarget(targetDb.url)) {
    throw new Error("Source and target database endpoints must be distinct");
  }
  if (canonicalApiTarget(sourceApiUrl) === canonicalApiTarget(targetApiUrl)) {
    throw new Error("Source and target API endpoints must be distinct");
  }

  return {
    sourceDb,
    targetDb,
    sourceApiUrl,
    targetApiUrl,
    sourceStackDir,
    targetStackDir,
    sourceServiceRoleKey,
    targetServiceRoleKey,
    tools: {
      psql: env.PSQL_BIN || "psql",
      pgDump: env.PG_DUMP_BIN || "pg_dump",
      pgRestore: env.PG_RESTORE_BIN || "pg_restore",
      createdb: env.CREATEDB_BIN || "createdb",
      dropdb: env.DROPDB_BIN || "dropdb",
    },
    secrets: [
      env.SOURCE_DB_URL,
      env.TARGET_DB_URL,
      decodeURIComponent(sourceDb.url.password),
      decodeURIComponent(targetDb.url.password),
      sourceServiceRoleKey,
      targetServiceRoleKey,
    ].filter(Boolean),
  };
}

export function preflightLocalStackIdentities(
  config,
  { readStatus = runSupabaseStatus } = {},
) {
  const sourceStack = readLocalStackIdentity(config.sourceStackDir, "Source stack");
  const targetStack = readLocalStackIdentity(config.targetStackDir, "Target stack");
  assertDistinctStackIdentities(sourceStack, targetStack);

  const sourceStatus = readStatus(sourceStack);
  assertSupabaseStatusMatches(
    {
      apiUrl: config.sourceApiUrl,
      dbUrl: config.sourceDb.url,
      serviceRoleKey: config.sourceServiceRoleKey,
    },
    sourceStatus,
    "Source stack",
  );
  const targetStatus = readStatus(targetStack);
  assertSupabaseStatusMatches(
    {
      apiUrl: config.targetApiUrl,
      dbUrl: config.targetDb.url,
      serviceRoleKey: config.targetServiceRoleKey,
    },
    targetStatus,
    "Target stack",
  );
  return { sourceStack, targetStack };
}

export function redactSensitive(value, secrets = []) {
  let result = String(value ?? "");
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length >= 4) result = result.replaceAll(secret, "[REDACTED]");
  }
  return result
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/giu, "$1[REDACTED]@")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[REDACTED_TOKEN]")
    .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b/gu, "[REDACTED_TOKEN]");
}

function connectionArgs(db) {
  return [
    "--host",
    normalizedHost(db.url.hostname),
    "--port",
    db.url.port,
    "--username",
    decodeURIComponent(db.url.username),
    "--dbname",
    db.database,
  ];
}

export function databaseCommandEnv(db, sourceEnv = process.env) {
  return sanitizedCommandEnv(sourceEnv, {
    PGCONNECT_TIMEOUT: "3",
    PGPASSWORD: decodeURIComponent(db.url.password),
  });
}

function run(binary, args, { db, secrets, timeout = COMMAND_TIMEOUT_MS } = {}) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    env: db ? databaseCommandEnv(db) : sanitizedCommandEnv(process.env),
    maxBuffer: 256 * 1024 * 1024,
    timeout,
  });
  if (result.error || result.status !== 0) {
    const detail = redactSensitive(
      result.stderr || result.stdout || result.error?.message || `exit ${result.status}`,
      secrets,
    ).slice(-4_000);
    throw new Error(`${basename(binary)} failed: ${detail}`);
  }
  return result.stdout;
}

function query(db, sql, config) {
  return run(
    config.tools.psql,
    [...connectionArgs(db), "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { db, secrets: config.secrets },
  ).trim();
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function databaseIdentity(db, config) {
  const raw = query(
    db,
    `select json_build_object(
       'database', current_database(),
       'role', current_user,
       'superuser', (select rolsuper from pg_roles where rolname = current_user),
       'server_version_num', current_setting('server_version_num'),
       'system_identifier', (select system_identifier::text from pg_control_system())
     )::text`,
    config,
  );
  return JSON.parse(raw);
}

export function assertTargetRestoreAuthority(identity) {
  if (identity?.superuser !== true) {
    throw new Error(
      "Target restore connection must use a superuser on the disposable local stack",
    );
  }
}

function roleManifest(db, config) {
  const raw = query(
    db,
    `select coalesce(json_agg(role_row order by role_row->>'name'), '[]'::json)::text
       from (
         select json_build_object(
           'name', rolname,
           'super', rolsuper,
           'inherit', rolinherit,
           'create_role', rolcreaterole,
           'create_db', rolcreatedb,
           'login', rolcanlogin,
           'replication', rolreplication,
           'bypass_rls', rolbypassrls,
           'connection_limit', rolconnlimit
         ) role_row
         from pg_roles
         where rolname !~ '^pg_'
       ) roles`,
    config,
  );
  return JSON.parse(raw);
}

export function roleMembershipOptionProjection(major) {
  const numericMajor = Number(major);
  if (!Number.isFinite(numericMajor)) throw new Error("PostgreSQL major version is malformed");
  if (numericMajor >= 16) {
    return `membership.admin_option::text || E'\\t' || membership.inherit_option::text || E'\\t' ||
            membership.set_option::text`;
  }
  return `membership.admin_option::text || E'\\t' || 'not-supported' || E'\\t' || 'not-supported'`;
}

function roleMembershipManifest(db, major, config) {
  const optionProjection = roleMembershipOptionProjection(major);
  return query(
    db,
    `select granted.rolname || E'\\t' || member.rolname || E'\\t' || grantor.rolname || E'\\t' ||
            ${optionProjection}
       from pg_auth_members membership
       join pg_roles granted on granted.oid = membership.roleid
       join pg_roles member on member.oid = membership.member
       join pg_roles grantor on grantor.oid = membership.grantor
      where granted.rolname !~ '^pg_' and member.rolname !~ '^pg_'
      order by granted.rolname, member.rolname, grantor.rolname`,
    config,
  );
}

export function assertRoleCompatibility(sourceRoles, targetRoles) {
  const sourceByName = new Map(sourceRoles.map((role) => [role.name, role]));
  const targetByName = new Map(targetRoles.map((role) => [role.name, role]));
  for (const roleName of CRITICAL_ROLES) {
    if (!sourceByName.has(roleName) || !targetByName.has(roleName)) {
      throw new Error(`Critical restore role is missing: ${roleName}`);
    }
  }
  for (const [roleName, sourceRole] of sourceByName) {
    const targetRole = targetByName.get(roleName);
    if (!targetRole) throw new Error(`Target cluster lacks source role: ${roleName}`);
    if (JSON.stringify(sourceRole) !== JSON.stringify(targetRole)) {
      throw new Error(`Target role attributes differ: ${roleName}`);
    }
  }
}

function extensionManifest(db, config) {
  return query(
    db,
    `select e.extname || E'\\t' || e.extversion || E'\\t' || n.nspname
       from pg_extension e
       join pg_namespace n on n.oid = e.extnamespace
      order by e.extname`,
    config,
  );
}

export function canonicalizeSchemaDump(value) {
  return value
    .replace(/^\\restrict\s+\S+\s*$/gmu, "\\restrict [TOKEN]")
    .replace(/^\\unrestrict\s+\S+\s*$/gmu, "\\unrestrict [TOKEN]")
    .replace(/[ \t]+$/gmu, "")
    .trim();
}

function schemaSnapshot(db, config) {
  const dump = run(
    config.tools.pgDump,
    [...connectionArgs(db), "--schema-only", "--no-owner"],
    { db, secrets: config.secrets },
  );
  const canonical = canonicalizeSchemaDump(dump);
  return { canonical, fingerprint: sha256(canonical) };
}

export function summarizeSchemaDifference(source, restored) {
  const sourceLines = source.split("\n");
  const restoredLines = restored.split("\n");
  const counts = (lines) => {
    const values = new Map();
    for (const line of lines) values.set(line, (values.get(line) || 0) + 1);
    return values;
  };
  const unmatched = (left, right) => {
    const leftCounts = counts(left);
    const rightCounts = counts(right);
    return [...leftCounts].flatMap(([line, count]) =>
      Array(Math.max(0, count - (rightCounts.get(line) || 0))).fill(line),
    );
  };
  const summarize = (lines) =>
    lines
      .filter((line) => line.trim() && line.trim() !== "--")
      .slice(0, 12)
      .map((line) => ({
        sha256: sha256(line),
        preview: redactSensitive(line).slice(0, 240),
      }));
  const sourceOnly = unmatched(sourceLines, restoredLines);
  const restoredOnly = unmatched(restoredLines, sourceLines);
  return {
    source_lines: sourceLines.length,
    restored_lines: restoredLines.length,
    source_only_lines: sourceOnly.length,
    restored_only_lines: restoredOnly.length,
    source_only_preview: summarize(sourceOnly),
    restored_only_preview: summarize(restoredOnly),
  };
}

function unmatchedSchemaLines(left, right) {
  const counts = (lines) => {
    const values = new Map();
    for (const line of lines) values.set(line, (values.get(line) || 0) + 1);
    return values;
  };
  const leftCounts = counts(left.split("\n"));
  const rightCounts = counts(right.split("\n"));
  return [...leftCounts].flatMap(([line, count]) =>
    Array(Math.max(0, count - (rightCounts.get(line) || 0))).fill(line),
  );
}

function normalizedSingleLineCheckConstraint(line) {
  if (!/^\s+CONSTRAINT\s+.+\s+CHECK\s+\(/u.test(line)) return null;
  // PostgreSQL can flatten associative Boolean expression nodes after parsing
  // a restored CHECK definition. Keep every identifier, literal and operator
  // token in order; remove only whitespace and parentheses for this one class
  // of already-successfully-restored schema line.
  return line.replace(/[\s()]/gu, "");
}

export function assertOnlyCheckConstraintParserNormalization(source, restored) {
  const sourceOnly = unmatchedSchemaLines(source, restored).filter(
    (line) => line.trim() && line.trim() !== "--",
  );
  const restoredOnly = unmatchedSchemaLines(restored, source).filter(
    (line) => line.trim() && line.trim() !== "--",
  );
  const sourceNormalized = sourceOnly.map(normalizedSingleLineCheckConstraint);
  const restoredNormalized = restoredOnly.map(normalizedSingleLineCheckConstraint);
  if (
    sourceNormalized.some((line) => line === null) ||
    restoredNormalized.some((line) => line === null) ||
    JSON.stringify(sourceNormalized.sort()) !== JSON.stringify(restoredNormalized.sort())
  ) {
    throw new Error("Schema mismatch is not limited to CHECK parser normalization");
  }
  return sourceOnly.length;
}

export function canonicalizeRestoreStableSchemaDump(value) {
  return canonicalizeSchemaDump(value)
    .split("\n")
    .map((line) => normalizedSingleLineCheckConstraint(line) ?? line)
    .join("\n");
}

function dataManifest(db, config) {
  const relationRows = query(
    db,
    `select n.nspname || E'\\t' || c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p')
        and n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname !~ '^pg_toast'
      order by n.nspname, c.relname`,
    config,
  );
  const rows = relationRows ? relationRows.split("\n") : [];
  const manifest = [];
  let totalRows = 0;
  for (const row of rows) {
    const [schema, table] = row.split("\t");
    const value = query(
      db,
      `select count(*)::text || '|' ||
              md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' order by md5(to_jsonb(t)::text)), ''))
         from ${quoteIdentifier(schema)}.${quoteIdentifier(table)} t`,
      config,
    );
    totalRows += Number(value.split("|", 1)[0]);
    manifest.push(`${schema}.${table}|${value}`);
  }

  const sequenceRows = query(
    db,
    `select schemaname || E'\\t' || sequencename
       from pg_sequences
      where schemaname not in ('pg_catalog', 'information_schema')
      order by schemaname, sequencename`,
    config,
  );
  for (const row of sequenceRows ? sequenceRows.split("\n") : []) {
    const [schema, sequence] = row.split("\t");
    const state = query(
      db,
      `select last_value::text || '|' || is_called::text
         from ${quoteIdentifier(schema)}.${quoteIdentifier(sequence)}`,
      config,
    );
    manifest.push(`sequence:${schema}.${sequence}|${state}`);
  }
  return { fingerprint: sha256(manifest.join("\n")), relations: rows.length, totalRows };
}

function storageMetadataCounts(db, bucket, path, config) {
  const raw = query(
    db,
    `select json_build_object(
       'buckets', (select count(*) from storage.buckets where id = ${quoteLiteral(bucket)}),
       'objects', (select count(*) from storage.objects
                    where bucket_id = ${quoteLiteral(bucket)} and name = ${quoteLiteral(path)})
     )::text`,
    config,
  );
  return JSON.parse(raw);
}

function assertStorageMetadata(db, bucket, path, expected, config, label) {
  const counts = storageMetadataCounts(db, bucket, path, config);
  if (Number(counts.buckets) !== expected || Number(counts.objects) !== expected) {
    throw new Error(`${label} Storage metadata mismatch`);
  }
}

export function createNoRedirectFetch(fetchImplementation = globalThis.fetch) {
  if (typeof fetchImplementation !== "function") {
    throw new Error("A fetch implementation is required");
  }
  return (input, init = {}) =>
    fetchImplementation(input, { ...init, redirect: "error" });
}

function createSupabaseClient(url, key) {
  return createClient(url.origin, key, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: {
      fetch: createNoRedirectFetch(),
      headers: { "x-client-info": "nailiq-mqa0192-cold-restore" },
    },
  });
}

async function assertApiReady(url, key) {
  const started = performance.now();
  const response = await fetch(new URL("/auth/v1/health", url), {
    headers: { apikey: key, authorization: `Bearer ${key}` },
    redirect: "error",
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Local Supabase API health failed with HTTP ${response.status}`);
  return Math.round(performance.now() - started);
}

async function assertStorageApiDbPairingReadOnly(client, db, config, label) {
  const { data, error } = await client.storage.listBuckets();
  if (error || !data) throw new Error(`${label} Storage read-only preflight failed: ${error?.message || "empty body"}`);
  const apiBucketIds = data.map((bucket) => bucket.id).sort();
  const dbBucketIds = JSON.parse(
    query(
      db,
      "select coalesce(json_agg(id order by id), '[]'::json)::text from storage.buckets",
      config,
    ),
  );
  if (JSON.stringify(apiBucketIds) !== JSON.stringify(dbBucketIds)) {
    throw new Error(`${label} API is not paired with the supplied local database`);
  }
}

export async function createStorageCanary(client, bucket, path, bytes, onBucketCreated = () => {}) {
  const { error: bucketError } = await client.storage.createBucket(bucket, {
    allowedMimeTypes: ["application/octet-stream"],
    fileSizeLimit: 1_024,
    public: false,
  });
  if (bucketError) throw new Error(`Storage canary bucket creation failed: ${bucketError.message}`);
  onBucketCreated();

  const { error: uploadError } = await client.storage.from(bucket).upload(path, bytes, {
    cacheControl: "0",
    contentType: "application/octet-stream",
    upsert: false,
  });
  if (uploadError) throw new Error(`Storage canary upload failed: ${uploadError.message}`);

  const { data, error: downloadError } = await client.storage.from(bucket).download(path);
  if (downloadError || !data) {
    throw new Error(`Storage canary download failed: ${downloadError?.message || "empty body"}`);
  }
  const downloaded = new Uint8Array(await data.arrayBuffer());
  if (sha256(downloaded) !== CANARY_SHA256) throw new Error("Storage canary byte hash mismatch");
  return downloaded;
}

export async function cleanupStorageCanary(client, bucket, path) {
  const messages = [];
  const { error: removeError } = await client.storage.from(bucket).remove([path]);
  if (removeError) messages.push(`object removal: ${removeError.message}`);
  const { error: emptyError } = await client.storage.emptyBucket(bucket);
  if (emptyError) messages.push(`bucket empty: ${emptyError.message}`);
  const { error: deleteError } = await client.storage.deleteBucket(bucket);
  if (deleteError) messages.push(`bucket deletion: ${deleteError.message}`);
  if (messages.length) throw new Error(messages.join("; "));
}

function createDatabase(targetDb, database, config) {
  run(
    config.tools.createdb,
    [
      "--host",
      normalizedHost(targetDb.url.hostname),
      "--port",
      targetDb.url.port,
      "--username",
      decodeURIComponent(targetDb.url.username),
      "--maintenance-db",
      targetDb.database,
      "--template",
      "template0",
      database,
    ],
    { db: targetDb, secrets: config.secrets },
  );
}

function dropDatabase(targetDb, database, config) {
  run(
    config.tools.dropdb,
    [
      "--host",
      normalizedHost(targetDb.url.hostname),
      "--port",
      targetDb.url.port,
      "--username",
      decodeURIComponent(targetDb.url.username),
      "--maintenance-db",
      targetDb.database,
      "--force",
      "--if-exists",
      database,
    ],
    { db: targetDb, secrets: config.secrets },
  );
}

function databaseWithName(db, database) {
  const url = new URL(db.url);
  url.pathname = `/${encodeURIComponent(database)}`;
  return { url, database };
}

export function restoreArchiveArgs(archive, restoredDb) {
  return [
    ...connectionArgs(restoredDb),
    "--exit-on-error",
    "--single-transaction",
    archive,
  ];
}

function restoreArchive(archive, restoredDb, config) {
  run(
    config.tools.pgRestore,
    restoreArchiveArgs(archive, restoredDb),
    { db: restoredDb, secrets: config.secrets },
  );
}

function dumpArchive(archive, sourceDb, config) {
  run(
    config.tools.pgDump,
    [...connectionArgs(sourceDb), "--format=custom", "--compress=6", "--file", archive],
    { db: sourceDb, secrets: config.secrets },
  );
  chmodSync(archive, 0o600);
  run(config.tools.pgRestore, ["--list", archive], { secrets: config.secrets });
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function executeColdRestore(
  env = process.env,
  {
    preflight = preflightLocalStackIdentities,
    makeTemporaryDirectory = mkdtempSync,
  } = {},
) {
  const config = validateConfig(env);
  // This identity proof must finish before any temporary artifacts, API calls,
  // database queries, pg_dump, or restore-side effects are possible.
  const stackIdentity = preflight(config);
  const work = makeTemporaryDirectory(join(tmpdir(), "nailiq-mqa0192-cold-restore-"));
  const archive = join(work, "database.dump");
  const storageSidecar = join(work, "storage-canary.bin");
  const token = randomUUID().replaceAll("-", "");
  const bucket = `mqa0192-${token}`;
  const objectPath = "known-sha256-canary.bin";
  const restoreDatabase = `nq_mqa0192_restore_${token.slice(0, 20)}`;
  const restoredDb = databaseWithName(config.targetDb, restoreDatabase);
  const canaryBytes = new TextEncoder().encode(CANARY_TEXT);
  if (sha256(canaryBytes) !== CANARY_SHA256) throw new Error("Embedded Storage canary hash changed");

  const sourceClient = createSupabaseClient(config.sourceApiUrl, config.sourceServiceRoleKey);
  const targetClient = createSupabaseClient(config.targetApiUrl, config.targetServiceRoleKey);
  let sourceBucketCreated = false;
  let targetBucketCreated = false;
  let restoreAttempted = false;
  let evidence;
  let primaryError;
  const cleanupErrors = [];

  try {
    const sourceIdentity = databaseIdentity(config.sourceDb, config);
    const targetIdentity = databaseIdentity(config.targetDb, config);
    if (sourceIdentity.system_identifier === targetIdentity.system_identifier) {
      throw new Error("Source and target must be independent PostgreSQL clusters");
    }
    // A full logical archive includes managed Supabase schemas whose functions
    // and ownership must be recreated exactly. Fail before the canary/dump when
    // the target login cannot restore those definitions and owners.
    assertTargetRestoreAuthority(targetIdentity);
    const sourcePostgresMajor = postgresMajor(sourceIdentity.server_version_num);
    const targetPostgresMajor = postgresMajor(targetIdentity.server_version_num);
    if (sourcePostgresMajor !== targetPostgresMajor) {
      throw new Error("Source and target PostgreSQL major versions differ");
    }
    const sourceRoles = roleManifest(config.sourceDb, config);
    const targetRoles = roleManifest(config.targetDb, config);
    assertRoleCompatibility(sourceRoles, targetRoles);
    const sourceMemberships = roleMembershipManifest(config.sourceDb, sourcePostgresMajor, config);
    const targetMemberships = roleMembershipManifest(config.targetDb, targetPostgresMajor, config);
    if (sourceMemberships !== targetMemberships) throw new Error("Target role memberships differ");

    const apiReadinessStarted = performance.now();
    const [sourceApiMs, targetApiMs] = await Promise.all([
      assertApiReady(config.sourceApiUrl, config.sourceServiceRoleKey),
      assertApiReady(config.targetApiUrl, config.targetServiceRoleKey),
    ]);
    const apiReadinessMs = Math.round(performance.now() - apiReadinessStarted);
    await Promise.all([
      assertStorageApiDbPairingReadOnly(sourceClient, config.sourceDb, config, "Source"),
      assertStorageApiDbPairingReadOnly(targetClient, config.targetDb, config, "Target"),
    ]);

    const extractedSourceBytes = await createStorageCanary(sourceClient, bucket, objectPath, canaryBytes, () => {
      sourceBucketCreated = true;
    });
    assertStorageMetadata(config.sourceDb, bucket, objectPath, 1, config, "Source API/DB pairing");
    writeFileSync(storageSidecar, extractedSourceBytes, { mode: 0o600 });

    const dumpStarted = performance.now();
    dumpArchive(archive, config.sourceDb, config);
    const dumpMs = Math.round(performance.now() - dumpStarted);
    const sourceSchema = schemaSnapshot(config.sourceDb, config);
    const sourceData = dataManifest(config.sourceDb, config);
    const sourceExtensions = extensionManifest(config.sourceDb, config);

    const createStarted = performance.now();
    const preexistingRestoreDatabase = query(
      config.targetDb,
      `select count(*) from pg_database where datname = ${quoteLiteral(restoreDatabase)}`,
      config,
    );
    if (preexistingRestoreDatabase !== "0") throw new Error("Generated restore database already exists");
    restoreAttempted = true;
    createDatabase(config.targetDb, restoreDatabase, config);
    const createDatabaseMs = Math.round(performance.now() - createStarted);

    const restoreStarted = performance.now();
    restoreArchive(archive, restoredDb, config);
    const restoreMs = Math.round(performance.now() - restoreStarted);

    const readinessStarted = performance.now();
    query(restoredDb, "select 1", config);
    const restoredDatabaseReadinessMs = Math.round(performance.now() - readinessStarted);

    const verifyStarted = performance.now();
    const restoredSchema = schemaSnapshot(restoredDb, config);
    const restoredData = dataManifest(restoredDb, config);
    const restoredExtensions = extensionManifest(restoredDb, config);
    let checkConstraintParserNormalizations = 0;
    if (sourceSchema.fingerprint !== restoredSchema.fingerprint) {
      try {
        checkConstraintParserNormalizations =
          assertOnlyCheckConstraintParserNormalization(
            sourceSchema.canonical,
            restoredSchema.canonical,
          );
      } catch {
        throw new Error(
          `Restored database schema fingerprint differs: ${JSON.stringify(
            summarizeSchemaDifference(sourceSchema.canonical, restoredSchema.canonical),
          )}`,
        );
      }
    }
    const sourceRestoreStableSchema = canonicalizeRestoreStableSchemaDump(
      sourceSchema.canonical,
    );
    const restoredRestoreStableSchema = canonicalizeRestoreStableSchemaDump(
      restoredSchema.canonical,
    );
    if (sourceRestoreStableSchema !== restoredRestoreStableSchema) {
      throw new Error("Restore-stable schema fingerprint differs");
    }
    if (sourceData.fingerprint !== restoredData.fingerprint) {
      throw new Error("Restored database data fingerprint differs");
    }
    if (sourceData.relations !== restoredData.relations || sourceData.totalRows !== restoredData.totalRows) {
      throw new Error("Restored database relation or row totals differ");
    }
    if (sourceExtensions !== restoredExtensions) throw new Error("Restored extension manifest differs");
    assertStorageMetadata(restoredDb, bucket, objectPath, 1, config, "Restored database");
    const databaseVerifyMs = Math.round(performance.now() - verifyStarted);

    const sidecarBytes = new Uint8Array(readFileSync(storageSidecar));
    if (sha256(sidecarBytes) !== CANARY_SHA256) throw new Error("Storage sidecar hash mismatch");
    const storageRestoreStarted = performance.now();
    await createStorageCanary(targetClient, bucket, objectPath, sidecarBytes, () => {
      targetBucketCreated = true;
    });
    assertStorageMetadata(config.targetDb, bucket, objectPath, 1, config, "Target API/DB pairing");
    const storageRestoreMs = Math.round(performance.now() - storageRestoreStarted);

    evidence = {
      result: "PASS_LOCAL",
      scope: "two-independent-loopback-supabase-stacks",
      stack_identity: {
        independent_cli_status: true,
        source_project_id: stackIdentity.sourceStack.projectId,
        target_project_id: stackIdentity.targetStack.projectId,
      },
      archive_bytes: readFileSync(archive).byteLength,
      database: {
        independent_clusters: true,
        exact_ownership_restored: true,
        target_restore_role: targetIdentity.role,
        postgres_major: sourcePostgresMajor,
        schema_sha256: sha256(sourceRestoreStableSchema),
        source_schema_raw_sha256: sourceSchema.fingerprint,
        restored_schema_raw_sha256: restoredSchema.fingerprint,
        check_constraint_parser_normalizations: checkConstraintParserNormalizations,
        data_sha256: sourceData.fingerprint,
        extensions_sha256: sha256(sourceExtensions),
        roles_checked: sourceRoles.length,
        role_memberships_sha256: sha256(sourceMemberships),
        relations_checked: sourceData.relations,
        rows_checked: sourceData.totalRows,
      },
      storage: {
        bytes: canaryBytes.byteLength,
        sha256: CANARY_SHA256,
        source_api_db_pairing: true,
        restored_database_metadata: true,
        target_api_byte_roundtrip: true,
        target_api_db_pairing: true,
      },
      timings_ms: {
        api_readiness_total: apiReadinessMs,
        source_api_health: sourceApiMs,
        target_api_health: targetApiMs,
        dump: dumpMs,
        create_restore_database: createDatabaseMs,
        restore: restoreMs,
        restored_database_readiness: restoredDatabaseReadinessMs,
        database_verify: databaseVerifyMs,
        storage_restore: storageRestoreMs,
      },
      cleanup: {
        source_storage: false,
        target_storage: false,
        restored_database: false,
        temporary_artifacts: false,
      },
      limitations: [
        "local disposable stacks only; this is not provider backup/PITR evidence",
        "Storage bytes use an explicit sidecar because PostgreSQL logical dumps contain metadata only",
        "the target API stack is not repointed to the temporary restored database",
        "PostgreSQL may flatten redundant parentheses in restored CHECK expressions; restore-stable hashing removes only whitespace/parentheses on paired single-line CHECK constraints while preserving all other tokens",
      ],
    };
  } catch (error) {
    primaryError = error;
  }

  if (sourceBucketCreated) {
    try {
      await cleanupStorageCanary(sourceClient, bucket, objectPath);
      assertStorageMetadata(config.sourceDb, bucket, objectPath, 0, config, "Source cleanup");
      if (evidence) evidence.cleanup.source_storage = true;
    } catch (error) {
      cleanupErrors.push(`source Storage cleanup: ${safeErrorMessage(error)}`);
    }
  }
  if (targetBucketCreated) {
    try {
      await cleanupStorageCanary(targetClient, bucket, objectPath);
      assertStorageMetadata(config.targetDb, bucket, objectPath, 0, config, "Target cleanup");
      if (evidence) evidence.cleanup.target_storage = true;
    } catch (error) {
      cleanupErrors.push(`target Storage cleanup: ${safeErrorMessage(error)}`);
    }
  }
  if (restoreAttempted) {
    try {
      dropDatabase(config.targetDb, restoreDatabase, config);
      const leftovers = query(
        config.targetDb,
        `select count(*) from pg_database where datname = ${quoteLiteral(restoreDatabase)}`,
        config,
      );
      if (leftovers !== "0") throw new Error("temporary restored database still exists");
      if (evidence) evidence.cleanup.restored_database = true;
    } catch (error) {
      cleanupErrors.push(`restored database cleanup: ${safeErrorMessage(error)}`);
    }
  }
  try {
    rmSync(work, { force: true, recursive: true });
    if (evidence) evidence.cleanup.temporary_artifacts = true;
  } catch (error) {
    cleanupErrors.push(`temporary artifact cleanup: ${safeErrorMessage(error)}`);
  }

  if (primaryError || cleanupErrors.length) {
    const messages = [];
    if (primaryError) messages.push(safeErrorMessage(primaryError));
    messages.push(...cleanupErrors);
    throw new Error(messages.join("; "));
  }
  return evidence;
}

export async function main(env = process.env) {
  const configSecrets = [
    env.SOURCE_DB_URL,
    env.TARGET_DB_URL,
    env.SOURCE_SUPABASE_SERVICE_ROLE_KEY,
    env.TARGET_SUPABASE_SERVICE_ROLE_KEY,
  ].filter(Boolean);
  try {
    const evidence = await executeColdRestore(env);
    console.log(`PASS_LOCAL Supabase cold restore: ${JSON.stringify(evidence)}`);
  } catch (error) {
    console.error(`FAIL_LOCAL Supabase cold restore: ${redactSensitive(safeErrorMessage(error), configSecrets)}`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) await main();
