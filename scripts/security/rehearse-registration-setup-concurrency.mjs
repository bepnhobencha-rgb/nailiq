#!/usr/bin/env node

/**
 * Real PostgreSQL two-session rehearsal for the existing-owner registration
 * completion RPC. It creates and destroys an isolated local cluster, applies
 * the exact migration, and proves writer-first role downgrade, membership
 * delete, and second-membership insert races fail closed.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const migrationPath = resolve(
  repoRoot,
  "supabase/migrations/20260820055259_complete_existing_owner_registration_setup.sql",
);

const initdb = process.env.INITDB_BIN ?? "initdb";
const pgCtl = process.env.PG_CTL_BIN ?? "pg_ctl";
const psql = process.env.PSQL_BIN ?? "psql";
const actorId = "00000000-0000-0000-0000-000000000101";
const targetSalonId = "00000000-0000-0000-0000-000000000001";
const otherSalonId = "00000000-0000-0000-0000-000000000002";

const tempRoot = await mkdtemp(
  join("/tmp", "nailiq-registration-setup-concurrency-"),
);
const dataDir = join(tempRoot, "data");
const logPath = join(tempRoot, "postgres.log");
const setupPath = join(tempRoot, "setup.sql");
const port = 54000 + (process.pid % 10000);
const connectionArgs = [
  "-X",
  "-v",
  "ON_ERROR_STOP=1",
  "-h",
  tempRoot,
  "-p",
  String(port),
  "-U",
  "postgres",
  "-d",
  "postgres",
];

let serverStarted = false;

const run = async (command, args, options = {}) => {
  const result = await execFileAsync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
  return result.stdout;
};

const sql = async (statement) =>
  run(psql, [...connectionArgs, "-Atq", "-c", statement]);

const startWriter = (name, statement) => {
  const child = spawn(
    psql,
    [...connectionArgs, "-Atq", "-c", statement],
    {
      cwd: repoRoot,
      env: { ...process.env, PGAPPNAME: name },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const done = new Promise((resolveDone, rejectDone) => {
    child.on("error", rejectDone);
    child.on("close", (code) => {
      if (code === 0) {
        resolveDone(stdout);
        return;
      }
      rejectDone(
        new Error(`${name} exited ${code}: ${stderr || stdout || "no output"}`),
      );
    });
  });

  return { child, done };
};

const waitForMembershipWriterLock = async (applicationName) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const count = Number(
      (
        await sql(`
          select count(*)
            from pg_locks as lock
            join pg_class as relation on relation.oid = lock.relation
            join pg_stat_activity as activity on activity.pid = lock.pid
           where relation.oid = 'public.salon_members'::regclass
             and lock.mode = 'RowExclusiveLock'
             and lock.granted
             and activity.application_name = '${applicationName}'
        `)
      ).trim(),
    );
    if (count === 1) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${applicationName} membership lock`);
};

const resetFixture = async () => {
  await sql(`
    delete from public.salon_members;
    update public.salons
       set name = 'Baseline Salon',
           slug = 'baseline-salon',
           timezone = 'UTC',
           setup_wizard_completed_at = null;
    insert into public.salon_members (salon_id, user_id, role)
    values ('${targetSalonId}', '${actorId}', 'owner');
  `);
};

const callCompletionRpc = async () => {
  const output = await sql(`
    set role service_role;
    select public.complete_existing_owner_registration_setup(
      '${targetSalonId}',
      '${actorId}',
      'Stale Completion',
      'stale-completion',
      'America/Vancouver'
    )::text;
  `);
  const resultLine = output.trim().split("\n").at(-1);
  return JSON.parse(resultLine);
};

const assertSalonUnchanged = async () => {
  const row = (
    await sql(`
      select concat_ws(
        '|',
        name,
        slug,
        timezone,
        coalesce(setup_wizard_completed_at::text, '<null>')
      )
        from public.salons
       where id = '${targetSalonId}'
    `)
  ).trim();
  assert.equal(row, "Baseline Salon|baseline-salon|UTC|<null>");
};

const runRace = async ({ name, mutation, expectedCode }) => {
  await resetFixture();
  const writer = startWriter(
    name,
    `begin; ${mutation}; select pg_sleep(1.5); commit;`,
  );

  try {
    await waitForMembershipWriterLock(name);
    const startedAt = Date.now();
    const result = await callCompletionRpc();
    const elapsedMs = Date.now() - startedAt;
    await writer.done;

    assert.equal(result.success, false, `${name} must fail closed`);
    assert.equal(result.code, expectedCode, `${name} returned wrong code`);
    assert.ok(
      elapsedMs >= 700,
      `${name} RPC did not wait for the writer (${elapsedMs}ms)`,
    );
    await assertSalonUnchanged();
    process.stdout.write(
      `PASS ${name}: ${expectedCode}, waited ${elapsedMs}ms, salon unchanged\n`,
    );
  } catch (error) {
    writer.child.kill("SIGTERM");
    await writer.done.catch(() => {});
    throw error;
  }
};

try {
  await run(initdb, [
    "-D",
    dataDir,
    "--auth=trust",
    "--no-locale",
    "--encoding=UTF8",
    "--username=postgres",
  ]);
  if (tempRoot.includes('"')) {
    throw new Error("Temporary path contains an unsupported quote character");
  }
  await run(pgCtl, [
    "-D",
    dataDir,
    "-l",
    logPath,
    "-o",
    `-k \"${tempRoot}\" -p ${port} -c listen_addresses=''`,
    "start",
  ]);
  serverStarted = true;

  const escapedMigrationPath = migrationPath.replaceAll("'", "''");
  await writeFile(
    setupPath,
    `
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin;

      create table public.salons (
        id uuid primary key,
        name text not null,
        slug text not null,
        timezone text not null,
        setup_wizard_completed_at timestamptz
      );

      create table public.salon_members (
        salon_id uuid not null references public.salons(id),
        user_id uuid not null,
        role text not null,
        primary key (salon_id, user_id)
      );

      grant select, update on table public.salons to service_role;
      grant select, update on table public.salon_members to service_role;
      \\i '${escapedMigrationPath}'

      insert into public.salons (id, name, slug, timezone)
      values
        ('${targetSalonId}', 'Baseline Salon', 'baseline-salon', 'UTC'),
        ('${otherSalonId}', 'Other Salon', 'other-salon', 'UTC');
    `,
    "utf8",
  );
  await run(psql, [...connectionArgs, "-f", setupPath]);

  await runRace({
    name: "owner-role-downgrade",
    mutation: `
      update public.salon_members
         set role = 'admin'
       where salon_id = '${targetSalonId}'
         and user_id = '${actorId}'
    `,
    expectedCode: "forbidden",
  });

  await runRace({
    name: "owner-membership-delete",
    mutation: `
      delete from public.salon_members
       where salon_id = '${targetSalonId}'
         and user_id = '${actorId}'
    `,
    expectedCode: "forbidden",
  });

  await runRace({
    name: "second-membership-insert",
    mutation: `
      insert into public.salon_members (salon_id, user_id, role)
      values ('${otherSalonId}', '${actorId}', 'owner')
    `,
    expectedCode: "ambiguous_membership",
  });
} finally {
  if (serverStarted) {
    await run(pgCtl, ["-D", dataDir, "-m", "fast", "stop"]).catch(
      async (error) => {
        process.stderr.write(`${error.message}\n${await readLogSafely()}\n`);
      },
    );
  }
  await rm(tempRoot, { recursive: true, force: true });
}

async function readLogSafely() {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(logPath, "utf8");
  } catch {
    return "PostgreSQL log unavailable";
  }
}
