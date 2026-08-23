import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertDistinctStackIdentities,
  assertSupabaseStatusMatches,
  parseSupabaseStatusJson,
  readLocalStackIdentity,
  runSupabaseStatus,
  sanitizedCommandEnv,
} from "./local-supabase-status.mjs";

const status = (overrides = {}) => ({
  apiUrl: "http://127.0.0.1:54321",
  dbUrl: "postgresql://postgres:cli-password@127.0.0.1:54322/postgres",
  anonKey: "local-anon-key",
  serviceRoleKey: "local-service-role-key",
  ...overrides,
});

function withStackFixtures(callback) {
  const root = mkdtempSync(join(tmpdir(), "nailiq-local-stack-status-test-"));
  const createStack = (name, projectId) => {
    const stackDir = join(root, name);
    mkdirSync(join(stackDir, "supabase"), { recursive: true });
    writeFileSync(
      join(stackDir, "supabase", "config.toml"),
      `project_id = "${projectId}"\n[api]\nport = 54321\n`,
    );
    return stackDir;
  };
  try {
    return callback({ root, createStack });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("parses the fixed Supabase status JSON contract", () => {
  assert.deepEqual(
    parseSupabaseStatusJson(
      JSON.stringify({
        API_URL: status().apiUrl,
        DB_URL: status().dbUrl,
        ANON_KEY: status().anonKey,
        SERVICE_ROLE_KEY: status().serviceRoleKey,
      }),
    ),
    status(),
  );
  assert.throws(() => parseSupabaseStatusJson("not-json"), /valid JSON/);
  assert.throws(
    () => parseSupabaseStatusJson(JSON.stringify({ API_URL: status().apiUrl })),
    /DB_URL/,
  );
});

test("requires exact API, DB target, anon key and service key identity", () => {
  const expected = {
    apiUrl: status().apiUrl,
    dbUrl: "postgresql://postgres:other-password@127.0.0.1:54322/postgres",
    anonKey: status().anonKey,
    serviceRoleKey: status().serviceRoleKey,
  };
  assert.doesNotThrow(() => assertSupabaseStatusMatches(expected, status()));
  assert.throws(
    () => assertSupabaseStatusMatches(expected, status({ apiUrl: "http://127.0.0.1:55321" })),
    /API URL/,
  );
  assert.throws(
    () => assertSupabaseStatusMatches(expected, status({ dbUrl: "postgresql://postgres:x@127.0.0.1:55322/postgres" })),
    /DB URL/,
  );
  assert.throws(
    () => assertSupabaseStatusMatches(expected, status({ anonKey: "wrong-anon-key" })),
    /anon key/,
  );
  assert.throws(
    () => assertSupabaseStatusMatches(expected, status({ serviceRoleKey: "wrong-service-key" })),
    /service-role key/,
  );
});

test("resolves stack realpaths and rejects alias or duplicate project identity", () =>
  withStackFixtures(({ root, createStack }) => {
    const sourceDir = createStack("source", "source-stack");
    const targetDir = createStack("target", "target-stack");
    const source = readLocalStackIdentity(sourceDir, "Source");
    const target = readLocalStackIdentity(targetDir, "Target");
    assert.doesNotThrow(() => assertDistinctStackIdentities(source, target));

    const sourceAlias = join(root, "source-alias");
    symlinkSync(sourceDir, sourceAlias);
    assert.throws(
      () => assertDistinctStackIdentities(source, readLocalStackIdentity(sourceAlias, "Alias")),
      /distinct realpaths/,
    );

    const duplicateDir = createStack("duplicate", "source-stack");
    assert.throws(
      () => assertDistinctStackIdentities(source, readLocalStackIdentity(duplicateDir, "Duplicate")),
      /project_id values must be distinct/,
    );
  }));

test("sanitized command environment excludes ambient provider and database credentials", () => {
  const env = sanitizedCommandEnv({
    PATH: "/safe/bin",
    LANG: "en_CA.UTF-8",
    SUPABASE_ACCESS_TOKEN: "provider-token",
    SUPABASE_SERVICE_ROLE_KEY: "service-key",
    PGPASSWORD: "ambient-password",
    VERCEL_TOKEN: "provider-token",
  });
  assert.equal(env.PATH, "/safe/bin");
  assert.equal(env.npm_config_offline, "true");
  assert.equal(env.SUPABASE_TELEMETRY_DISABLED, "1");
  assert.equal(env.SUPABASE_ACCESS_TOKEN, undefined);
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.equal(env.PGPASSWORD, undefined);
  assert.equal(env.VERCEL_TOKEN, undefined);
});

test("status command is repo-scoped, offline, non-interactive, and parses stdout", () =>
  withStackFixtures(({ createStack }) => {
    const stack = readLocalStackIdentity(createStack("source", "source-stack"));
    let invocation;
    const parsed = runSupabaseStatus(stack, {
      sourceEnv: { PATH: "/safe/bin", SUPABASE_ACCESS_TOKEN: "must-not-leak" },
      spawn: (binary, args, options) => {
        invocation = { binary, args, options };
        return {
          status: 0,
          stdout: JSON.stringify({
            API_URL: status().apiUrl,
            DB_URL: status().dbUrl,
            ANON_KEY: status().anonKey,
            SERVICE_ROLE_KEY: status().serviceRoleKey,
          }),
        };
      },
    });
    assert.deepEqual(parsed, status());
    assert.equal(invocation.binary, "npx");
    assert.deepEqual(invocation.args, [
      "--offline",
      "--yes=false",
      "supabase",
      "status",
      "--output",
      "json",
    ]);
    assert.equal(invocation.options.cwd, stack.stackDir);
    assert.equal(invocation.options.env.SUPABASE_ACCESS_TOKEN, undefined);
    assert.equal(invocation.options.env.npm_config_offline, "true");
  }));
