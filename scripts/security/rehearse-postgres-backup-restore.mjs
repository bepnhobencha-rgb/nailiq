#!/usr/bin/env node

/**
 * MQA-0161 local-only logical backup/restore rehearsal.
 *
 * This script deliberately refuses non-loopback databases. It creates one
 * explicitly named throwaway database in the same local PostgreSQL cluster,
 * restores a custom-format pg_dump into it, compares canonical schema/data/
 * application-contract fingerprints, then drops the restored database.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const sourceUrlText = process.env.DB_URL;
if (process.env.NAILIQ_DISPOSABLE_DB !== "1" || !sourceUrlText) {
  throw new Error("Refusing backup rehearsal without NAILIQ_DISPOSABLE_DB=1 and DB_URL");
}

const sourceUrl = new URL(sourceUrlText);
if (!new Set(["postgres:", "postgresql:"]).has(sourceUrl.protocol)) {
  throw new Error("DB_URL must be a PostgreSQL URL");
}
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
if (!loopbackHosts.has(sourceUrl.hostname)) {
  throw new Error("Refusing backup rehearsal against a non-loopback PostgreSQL host");
}

const sourceDatabase = decodeURIComponent(sourceUrl.pathname.replace(/^\//, ""));
if (!sourceDatabase || new Set(["template0", "template1"]).has(sourceDatabase)) {
  throw new Error("Refusing unsafe source database");
}

const tool = (envName, fallback) => process.env[envName] || fallback;
const psql = tool("PSQL_BIN", "psql");
const pgDump = tool("PG_DUMP_BIN", "pg_dump");
const pgRestore = tool("PG_RESTORE_BIN", "pg_restore");
const createdb = tool("CREATEDB_BIN", "createdb");
const dropdb = tool("DROPDB_BIN", "dropdb");
const work = mkdtempSync(join(tmpdir(), "nailiq-backup-restore-"));
const archive = join(work, "database.dump");
const restoreDatabase = `nq_restore_${process.pid}_${Date.now()}`;
const restoreUrl = new URL(sourceUrl.toString());
restoreUrl.pathname = `/${restoreDatabase}`;
restoreUrl.search = "";

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    let detail = result.stderr || result.stdout || result.error?.message || "unknown error";
    if (sourceUrl.password) detail = detail.replaceAll(sourceUrl.password, "[REDACTED]");
    detail = detail.slice(-4000);
    throw new Error(`${binary} failed: ${detail}`);
  }
  return result.stdout;
}

function query(url, sql) {
  return run(psql, [url.toString(), "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql]).trim();
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function quoteIdent(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function schemaManifest(url) {
  const manifest = query(
    url,
    `WITH schema_objects AS (
       SELECT 'schema' kind,n.nspname object_name,'' material
         FROM pg_catalog.pg_namespace n
        WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
       UNION ALL
       SELECT 'extension',e.extname,
              concat_ws('|',e.extversion,n.nspname)
         FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
       UNION ALL
       SELECT 'column',n.nspname || '.' || c.relname || '.' || a.attname,
              concat_ws('|',a.attnum,pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull,
                a.attidentity,a.attgenerated,coalesce(pg_catalog.pg_get_expr(d.adbin,d.adrelid),''),
                coalesce(coll.collname,''))
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
         LEFT JOIN pg_catalog.pg_collation coll ON coll.oid=a.attcollation AND a.attcollation<>0
        WHERE a.attnum>0 AND NOT a.attisdropped
          AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
          AND c.relkind IN ('r','p','v','m','S')
       UNION ALL
       SELECT 'constraint',n.nspname || '.' || c.relname || '.' || con.conname,
              concat_ws('|',con.contype,con.condeferrable,con.condeferred,con.convalidated,
                pg_catalog.pg_get_constraintdef(con.oid,true))
         FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
       UNION ALL
       SELECT 'index',n.nspname || '.' || c.relname,
              pg_catalog.pg_get_indexdef(c.oid)
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind='i' AND n.nspname NOT IN ('pg_catalog','information_schema')
          AND n.nspname !~ '^pg_toast'
       UNION ALL
       SELECT 'trigger',n.nspname || '.' || c.relname || '.' || t.tgname,
              concat_ws('|',t.tgenabled,pg_catalog.pg_get_triggerdef(t.oid,true))
         FROM pg_catalog.pg_trigger t
         JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog','information_schema')
          AND n.nspname !~ '^pg_toast'
       UNION ALL
       SELECT 'view',n.nspname || '.' || c.relname,
              pg_catalog.pg_get_viewdef(c.oid,true)
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind IN ('v','m') AND n.nspname NOT IN ('pg_catalog','information_schema')
          AND n.nspname !~ '^pg_toast'
       UNION ALL
       SELECT 'enum',n.nspname || '.' || t.typname || '.' || e.enumlabel,
              e.enumsortorder::text
         FROM pg_catalog.pg_enum e JOIN pg_catalog.pg_type t ON t.oid=e.enumtypid
         JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast'
       UNION ALL
       SELECT 'publication',p.pubname,
              concat_ws('|',p.pubinsert,p.pubupdate,p.pubdelete,p.pubtruncate,p.pubviaroot)
         FROM pg_catalog.pg_publication p
       UNION ALL
       SELECT 'publication_table',p.pubname || ':' || pt.schemaname || '.' || pt.tablename,''
         FROM pg_catalog.pg_publication p
         JOIN pg_catalog.pg_publication_tables pt ON pt.pubname=p.pubname
     )
     SELECT kind || E'\\t' || object_name || E'\\t' || material
       FROM schema_objects ORDER BY kind,object_name,material`,
  );
  return sha(manifest);
}

function dataManifest(url) {
  const relationRows = query(
    url,
    `SELECT n.nspname || E'\\t' || c.relname
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p')
        AND n.nspname NOT IN ('pg_catalog','information_schema')
        AND n.nspname !~ '^pg_toast'
      ORDER BY n.nspname,c.relname`,
  );
  const rows = relationRows ? relationRows.split("\n") : [];
  const manifest = [];
  let totalRows = 0;
  for (const row of rows) {
    const [schema, table] = row.split("\t");
    const value = query(
      url,
      `SELECT count(*)::text || '|' ||
              md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),''))
         FROM ${quoteIdent(schema)}.${quoteIdent(table)} t`,
    );
    totalRows += Number(value.split("|", 1)[0]);
    manifest.push(`${schema}.${table}|${value}`);
  }

  const sequenceRows = query(
    url,
    `SELECT schemaname || E'\\t' || sequencename
       FROM pg_catalog.pg_sequences
      WHERE schemaname NOT IN ('pg_catalog','information_schema')
      ORDER BY schemaname,sequencename`,
  );
  for (const row of sequenceRows ? sequenceRows.split("\n") : []) {
    const [schema, sequence] = row.split("\t");
    manifest.push(`sequence:${schema}.${sequence}|${query(
      url,
      `SELECT last_value::text || '|' || is_called::text FROM ${quoteIdent(schema)}.${quoteIdent(sequence)}`,
    )}`);
  }
  return { fingerprint: sha(manifest.join("\n")), relations: rows.length, totalRows };
}

function applicationManifest(url) {
  const manifest = query(
    url,
    `WITH app_objects AS (
       SELECT 'relation' kind,n.nspname schema_name,c.relname object_name,
              concat_ws('|',c.relkind,c.relrowsecurity,c.relforcerowsecurity) material
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','auth','storage') AND c.relkind IN ('r','p','v','m')
       UNION ALL
       SELECT 'function',n.nspname,p.proname,
              concat_ws('|',pg_catalog.pg_get_function_identity_arguments(p.oid),
                pg_catalog.pg_get_function_result(p.oid),p.prosecdef,p.provolatile,
                coalesce(array_to_string(p.proconfig,','),''),pg_catalog.pg_get_functiondef(p.oid))
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname IN ('public','auth','storage')
       UNION ALL
       SELECT 'policy',schemaname,tablename || ':' || policyname,
              concat_ws('|',permissive,roles::text,cmd,coalesce(qual,''),coalesce(with_check,''))
         FROM pg_catalog.pg_policies WHERE schemaname IN ('public','auth','storage')
       UNION ALL
       SELECT 'table_grant',table_schema,table_name || ':' || grantee,
              string_agg(privilege_type,',' ORDER BY privilege_type)
         FROM information_schema.role_table_grants
        WHERE table_schema IN ('public','auth','storage')
        GROUP BY table_schema,table_name,grantee
       UNION ALL
       SELECT 'column_grant',table_schema,table_name || ':' || column_name || ':' || grantee,
              string_agg(privilege_type,',' ORDER BY privilege_type)
         FROM information_schema.role_column_grants
        WHERE table_schema IN ('public','auth','storage')
        GROUP BY table_schema,table_name,column_name,grantee
     )
     SELECT kind || E'\\t' || schema_name || E'\\t' || object_name || E'\\t' || material
       FROM app_objects ORDER BY kind,schema_name,object_name,material`,
  );
  const critical = query(
    url,
    `SELECT bool_and(present)::text FROM (VALUES
       (to_regclass('public.salons') IS NOT NULL),
       (to_regclass('public.bookings') IS NOT NULL),
       (to_regclass('public.booking_payment_operations') IS NOT NULL),
       (to_regclass('public.staff_action_notification_outbox') IS NOT NULL),
       (EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='public' AND p.proname='create_public_booking')),
       (EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='public' AND p.proname='claim_booking_payment_operation')),
       (EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='public' AND p.proname='current_auth_session_is_active'))
     ) AS required(present)`,
  );
  if (critical !== "true") throw new Error("Critical application objects are missing");
  query(url, "SELECT count(*) FROM public.salons; SELECT count(*) FROM public.public_salon_profiles");
  return sha(manifest);
}

let restoreCreated = false;
try {
  const server = query(sourceUrl, "SELECT current_setting('server_version_num') || '|' || current_database()");
  run(pgDump, ["--format=custom", "--compress=6", "--file", archive, sourceUrl.toString()]);
  run(pgRestore, ["--list", archive]);

  const sourceSchemaFingerprint = schemaManifest(sourceUrl);
  const sourceData = dataManifest(sourceUrl);
  if (sourceData.totalRows < 1) throw new Error("Source has no data rows; data restore proof would be vacuous");
  const sourceApplication = applicationManifest(sourceUrl);

  run(createdb, ["--maintenance-db", sourceUrl.toString(), "--template", "template0", restoreDatabase]);
  restoreCreated = true;
  run(pgRestore, ["--exit-on-error", "--single-transaction", "--dbname", restoreUrl.toString(), archive]);

  const schemaRestoreFingerprint = schemaManifest(restoreUrl);
  const restoredData = dataManifest(restoreUrl);
  const restoredApplication = applicationManifest(restoreUrl);

  const evidence = {
    server,
    archive_bytes: readFileSync(archive).byteLength,
    schema_fingerprint: sourceSchemaFingerprint,
    data_fingerprint: sourceData.fingerprint,
    application_fingerprint: sourceApplication,
    relations_checked: sourceData.relations,
    rows_checked: sourceData.totalRows,
  };
  writeFileSync(join(work, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);

  if (sourceSchemaFingerprint !== schemaRestoreFingerprint) throw new Error("Schema checksum mismatch after restore");
  if (sourceData.fingerprint !== restoredData.fingerprint) throw new Error("Data checksum mismatch after restore");
  if (sourceApplication !== restoredApplication) throw new Error("Application contract checksum mismatch after restore");
  if (sourceData.relations !== restoredData.relations || sourceData.totalRows !== restoredData.totalRows) {
    throw new Error("Restored relation/row totals differ from source");
  }

  console.log(`PASS_LOCAL PostgreSQL backup restore: ${JSON.stringify(evidence)}`);
} finally {
  if (restoreCreated) {
    run(dropdb, ["--maintenance-db", sourceUrl.toString(), "--if-exists", restoreDatabase]);
  }
  rmSync(work, { recursive: true, force: true });
}
