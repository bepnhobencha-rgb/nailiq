import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CANARY_SHA256,
  CANARY_TEXT,
  COLD_RESTORE_APPROVAL,
  assertTargetRestoreAuthority,
  assertRoleCompatibility,
  assertOnlyCheckConstraintParserNormalization,
  canonicalDatabaseTarget,
  canonicalizeSchemaDump,
  canonicalizeRestoreStableSchemaDump,
  cleanupStorageCanary,
  createNoRedirectFetch,
  createStorageCanary,
  databaseCommandEnv,
  executeColdRestore,
  postgresMajor,
  preflightLocalStackIdentities,
  redactSensitive,
  restoreArchiveArgs,
  roleMembershipOptionProjection,
  sha256,
  summarizeSchemaDifference,
  validateConfig,
} from "./rehearse-supabase-cold-restore.mjs";

const validEnv = () => ({
  NAILIQ_COLD_RESTORE_APPROVAL: COLD_RESTORE_APPROVAL,
  NAILIQ_DISPOSABLE_SOURCE_STACK: "1",
  NAILIQ_DISPOSABLE_TARGET_STACK: "1",
  SOURCE_DB_URL: "postgresql://postgres:source-password@127.0.0.1:54322/postgres",
  TARGET_DB_URL: "postgresql://postgres:target-password@127.0.0.1:55322/postgres",
  SOURCE_SUPABASE_URL: "http://127.0.0.1:54321",
  TARGET_SUPABASE_URL: "http://127.0.0.1:55321",
  SOURCE_SUPABASE_SERVICE_ROLE_KEY: "source-service-role-key-at-least-twenty",
  TARGET_SUPABASE_SERVICE_ROLE_KEY: "target-service-role-key-at-least-twenty",
  SOURCE_STACK_DIR: "/tmp/nailiq-mqa0192-source-stack",
  TARGET_STACK_DIR: "/tmp/nailiq-mqa0192-target-stack",
});

function withStackFixtures(callback) {
  const root = mkdtempSync(join(tmpdir(), "nailiq-mqa0192-stack-test-"));
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
    return callback({ createStack });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function statusFor(config, side) {
  const source = side === "source";
  return {
    apiUrl: (source ? config.sourceApiUrl : config.targetApiUrl).origin,
    dbUrl: (source ? config.sourceDb : config.targetDb).url.href,
    anonKey: `${side}-anon-key`,
    serviceRoleKey: source
      ? config.sourceServiceRoleKey
      : config.targetServiceRoleKey,
  };
}

test("accepts only explicit, distinct loopback stack targets", () => {
  const config = validateConfig(validEnv());
  assert.equal(canonicalDatabaseTarget(config.sourceDb.url), "postgresql://127.0.0.1:54322/postgres");
  assert.equal(canonicalDatabaseTarget(config.targetDb.url), "postgresql://127.0.0.1:55322/postgres");
});

test("requires both independently addressable stack directories", () => {
  for (const key of ["SOURCE_STACK_DIR", "TARGET_STACK_DIR"]) {
    const env = validEnv();
    delete env[key];
    assert.throws(() => validateConfig(env), new RegExp(`${key} is required`));
  }
});

test("preflight pins each stack realpath/project_id/API/DB/service key", () =>
  withStackFixtures(({ createStack }) => {
    const env = validEnv();
    env.SOURCE_STACK_DIR = createStack("source", "mqa0192-source");
    env.TARGET_STACK_DIR = createStack("target", "mqa0192-target");
    const config = validateConfig(env);
    const statuses = new Map([
      ["mqa0192-source", statusFor(config, "source")],
      ["mqa0192-target", statusFor(config, "target")],
    ]);
    const identity = preflightLocalStackIdentities(config, {
      readStatus: (stack) => statuses.get(stack.projectId),
    });
    assert.equal(identity.sourceStack.projectId, "mqa0192-source");
    assert.equal(identity.targetStack.projectId, "mqa0192-target");

    statuses.set("mqa0192-target", {
      ...statusFor(config, "target"),
      serviceRoleKey: "wrong-target-service-role-key",
    });
    assert.throws(
      () =>
        preflightLocalStackIdentities(config, {
          readStatus: (stack) => statuses.get(stack.projectId),
        }),
      /Target stack service-role key/,
    );
  }));

test("preflight rejects duplicate project_id before reading either status", () =>
  withStackFixtures(({ createStack }) => {
    const env = validEnv();
    env.SOURCE_STACK_DIR = createStack("source", "duplicate-project");
    env.TARGET_STACK_DIR = createStack("target", "duplicate-project");
    const config = validateConfig(env);
    let statusReads = 0;
    assert.throws(
      () =>
        preflightLocalStackIdentities(config, {
          readStatus: () => {
            statusReads += 1;
            return statusFor(config, "source");
          },
        }),
      /project_id values must be distinct/,
    );
    assert.equal(statusReads, 0);
  }));

test("identity failure happens before the harness creates a temporary directory", async () => {
  let temporaryDirectoryCreated = false;
  await assert.rejects(
    executeColdRestore(validEnv(), {
      preflight: () => {
        throw new Error("injected identity failure");
      },
      makeTemporaryDirectory: () => {
        temporaryDirectoryCreated = true;
        throw new Error("must not run");
      },
    }),
    /injected identity failure/,
  );
  assert.equal(temporaryDirectoryCreated, false);
});

test("all HTTP clients force redirect=error", async () => {
  let observedInit;
  const guardedFetch = createNoRedirectFetch(async (_input, init) => {
    observedInit = init;
    return { ok: true };
  });
  await guardedFetch("http://127.0.0.1:54321/storage/v1/bucket", {
    redirect: "follow",
    headers: { apikey: "test" },
  });
  assert.equal(observedInit.redirect, "error");
  assert.deepEqual(observedInit.headers, { apikey: "test" });
});

test("database commands receive only sanitized env plus the selected DB password", () => {
  const config = validateConfig(validEnv());
  const commandEnv = databaseCommandEnv(config.sourceDb, {
    PATH: "/safe/bin",
    SUPABASE_ACCESS_TOKEN: "provider-token",
    SUPABASE_SERVICE_ROLE_KEY: "ambient-service-role",
    PGPASSWORD: "ambient-password",
  });
  assert.equal(commandEnv.PATH, "/safe/bin");
  assert.equal(commandEnv.PGPASSWORD, "source-password");
  assert.equal(commandEnv.SUPABASE_ACCESS_TOKEN, undefined);
  assert.equal(commandEnv.SUPABASE_SERVICE_ROLE_KEY, undefined);
});

test("logical restore preserves source ownership changes", () => {
  const config = validateConfig(validEnv());
  const args = restoreArchiveArgs("/tmp/disposable.dump", config.targetDb);
  assert.ok(!args.includes("--no-owner"));
  assert.ok(args.includes("--single-transaction"));
  assert.equal(args.at(-1), "/tmp/disposable.dump");
});

test("full restore requires a target-local superuser", () => {
  assert.doesNotThrow(() =>
    assertTargetRestoreAuthority({ role: "supabase_admin", superuser: true }),
  );
  assert.throws(
    () => assertTargetRestoreAuthority({ role: "postgres", superuser: false }),
    /must use a superuser/,
  );
});

test("fails closed without all three opt-ins", () => {
  for (const key of [
    "NAILIQ_COLD_RESTORE_APPROVAL",
    "NAILIQ_DISPOSABLE_SOURCE_STACK",
    "NAILIQ_DISPOSABLE_TARGET_STACK",
  ]) {
    const env = validEnv();
    delete env[key];
    assert.throws(() => validateConfig(env));
  }
});

test("rejects any non-loopback database or API endpoint", () => {
  const remoteDb = validEnv();
  remoteDb.TARGET_DB_URL = "postgresql://postgres:password@db.example.com:5432/postgres";
  assert.throws(() => validateConfig(remoteDb), /loopback/);

  const remoteApi = validEnv();
  remoteApi.TARGET_SUPABASE_URL = "https://example.supabase.co:443";
  assert.throws(() => validateConfig(remoteApi), /loopback/);
});

test("rejects aliased source and target endpoints", () => {
  const sameDb = validEnv();
  sameDb.TARGET_DB_URL = "postgresql://other:other-password@127.0.0.1:54322/postgres";
  assert.throws(() => validateConfig(sameDb), /database endpoints must be distinct/);

  const sameApi = validEnv();
  sameApi.TARGET_SUPABASE_URL = sameApi.SOURCE_SUPABASE_URL;
  assert.throws(() => validateConfig(sameApi), /API endpoints must be distinct/);
});

test("rejects production-marked execution even with local endpoints", () => {
  const env = { ...validEnv(), VERCEL_ENV: "production" };
  assert.throws(() => validateConfig(env), /production-marked/);
});

test("redacts database passwords, JWTs and service-role secrets", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.signature_value";
  const secret = "source-service-role-key-at-least-twenty";
  const raw = `postgresql://postgres:hunter2@127.0.0.1:54322/postgres ${jwt} ${secret}`;
  const redacted = redactSensitive(raw, [secret, "hunter2"]);
  assert.doesNotMatch(redacted, /hunter2|source-service-role|eyJ/);
  assert.match(redacted, /REDACTED/);
});

test("normalizes pg_dump random restrict tokens before hashing", () => {
  const first = "\\restrict first-random-token\nCREATE SCHEMA public;\n\\unrestrict first-random-token\n";
  const second = "\\restrict other-token\nCREATE SCHEMA public;   \n\\unrestrict other-token\n";
  assert.equal(canonicalizeSchemaDump(first), canonicalizeSchemaDump(second));
});

test("schema mismatch diagnostics stay bounded and identify both sides", () => {
  const summary = summarizeSchemaDifference(
    "CREATE TABLE public.a ();\nALTER TABLE public.a ENABLE ROW LEVEL SECURITY;",
    "CREATE TABLE public.a ();\nCREATE TABLE public.b ();",
  );
  assert.equal(summary.source_only_lines, 1);
  assert.equal(summary.restored_only_lines, 1);
  assert.match(summary.source_only_preview[0].preview, /ENABLE ROW LEVEL SECURITY/);
  assert.match(summary.restored_only_preview[0].preview, /public\.b/);
});

test("accepts only paired CHECK-expression parenthesis normalization", () => {
  const source = [
    "CREATE TABLE public.a (",
    "    CONSTRAINT a_check CHECK (((a > 0) AND ((b > 0) AND (c > 0))))",
    ");",
  ].join("\n");
  const restored = [
    "CREATE TABLE public.a (",
    "    CONSTRAINT a_check CHECK ((a > 0) AND (b > 0) AND (c > 0))",
    ");",
  ].join("\n");
  assert.equal(assertOnlyCheckConstraintParserNormalization(source, restored), 1);
  assert.equal(
    canonicalizeRestoreStableSchemaDump(source),
    canonicalizeRestoreStableSchemaDump(restored),
  );
  assert.throws(
    () =>
      assertOnlyCheckConstraintParserNormalization(
        source,
        restored.replace("c > 0", "c >= 0"),
      ),
    /not limited to CHECK/,
  );
  assert.throws(
    () =>
      assertOnlyCheckConstraintParserNormalization(
        source,
        source.replace("CREATE TABLE", "CREATE UNLOGGED TABLE"),
      ),
    /not limited to CHECK/,
  );
});

test("embedded Storage canary has an immutable known hash", () => {
  assert.equal(Buffer.byteLength(CANARY_TEXT), 39);
  assert.equal(sha256(CANARY_TEXT), CANARY_SHA256);
});

test("parses PostgreSQL server_version_num without two-character assumptions", () => {
  assert.equal(postgresMajor("170006"), "17");
  assert.equal(postgresMajor("150014"), "15");
  assert.equal(postgresMajor("90624"), "9.6");
  assert.throws(() => postgresMajor("17.6"), /malformed/);
  assert.throws(() => postgresMajor("80000"), /unsupported/);
});

test("uses only PostgreSQL 15 membership columns on legacy catalogs", () => {
  const pg15 = roleMembershipOptionProjection("15");
  assert.match(pg15, /admin_option/);
  assert.doesNotMatch(pg15, /inherit_option|set_option/);
  assert.match(pg15, /not-supported/);

  const pg16 = roleMembershipOptionProjection("16");
  assert.match(pg16, /admin_option|inherit_option|set_option/);
  assert.match(pg16, /inherit_option/);
  assert.match(pg16, /set_option/);
});

test("role compatibility requires critical roles and matching attributes", () => {
  const names = [
    "anon",
    "authenticated",
    "authenticator",
    "postgres",
    "service_role",
    "supabase_auth_admin",
    "supabase_storage_admin",
  ];
  const roles = names.map((name) => ({ name, login: name === "postgres" }));
  assert.doesNotThrow(() => assertRoleCompatibility(roles, structuredClone(roles)));
  assert.throws(() => assertRoleCompatibility(roles, roles.slice(1)), /missing/);
  const changed = structuredClone(roles);
  changed[0].login = true;
  assert.throws(() => assertRoleCompatibility(roles, changed), /attributes differ/);
});

test("marks a newly created bucket before a later upload failure", async () => {
  let created = false;
  const client = {
    storage: {
      createBucket: async () => ({ error: null }),
      from: () => ({
        upload: async () => ({ error: { message: "injected upload failure" } }),
      }),
    },
  };
  await assert.rejects(
    createStorageCanary(client, "bucket", "canary.bin", new Uint8Array([1]), () => {
      created = true;
    }),
    /injected upload failure/,
  );
  assert.equal(created, true);
});

test("returns bytes downloaded back from source Storage for the sidecar", async () => {
  const extracted = new TextEncoder().encode(CANARY_TEXT);
  const client = {
    storage: {
      createBucket: async () => ({ error: null }),
      from: () => ({
        upload: async () => ({ error: null }),
        download: async () => ({ data: new Blob([extracted]), error: null }),
      }),
    },
  };
  const downloaded = await createStorageCanary(
    client,
    "bucket",
    "canary.bin",
    new Uint8Array(extracted),
  );
  assert.deepEqual(downloaded, extracted);
  assert.equal(sha256(downloaded), CANARY_SHA256);
});

test("cleanup attempts object, bucket empty, and bucket deletion even after errors", async () => {
  const calls = [];
  const client = {
    storage: {
      from: () => ({
        remove: async () => {
          calls.push("remove");
          return { error: { message: "injected remove failure" } };
        },
      }),
      emptyBucket: async () => {
        calls.push("empty");
        return { error: null };
      },
      deleteBucket: async () => {
        calls.push("delete");
        return { error: null };
      },
    },
  };
  await assert.rejects(cleanupStorageCanary(client, "bucket", "canary.bin"), /injected remove failure/);
  assert.deepEqual(calls, ["remove", "empty", "delete"]);
});
