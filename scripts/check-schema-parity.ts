/**
 * Does the local database actually look like production?
 *
 * `psql -f schema.sql` exiting 0 is not the same as "the schema is there".
 * A baseline can apply cleanly and still be missing half the RLS policies — and
 * a database with the tables but not the policies makes the suite pass for
 * entirely the wrong reason. Tenant-isolation tests would go green against a
 * database that isolates nothing.
 *
 * So: count what landed, compare against production's shape, and name anything
 * that is short.
 *
 * Reads DB_URL (exported by `supabase status`). Shells out to psql rather than
 * adding a Postgres driver to the app's dependency tree for a CI-only check.
 *
 * Usage:  npx tsx scripts/check-schema-parity.ts
 */
import { execFileSync } from "node:child_process";

/**
 * Production's shape, measured 2026-07-14 against project fshmobzyjhmtvndobwsy.
 * Refresh these when the baseline is refreshed — they are a tripwire, not a spec.
 */
const PRODUCTION = {
  tables: 81,
  columns: 1064,
  policies: 101,
  functions: 253,
  triggers: 24,
  indexes: 265,
} as const;

/**
 * How far below production a count may fall before we fail.
 *
 * Not zero, deliberately. A local Supabase stack ships its own `auth`/`storage`
 * schemas and a handful of helper functions, and a dump taken at a slightly
 * different moment than these numbers were measured will differ by a few. What
 * we are hunting is a baseline that dropped a WHOLE CLASS of object — half the
 * policies, all the triggers — not a drift of three.
 */
const TOLERANCE = 0.9; // must retain at least 90% of production's count

/** Tables the product cannot function without. Absence here is fatal, not a ratio. */
const CRITICAL_TABLES = [
  "salons",
  "bookings",
  "staff",
  "services",
  "client_profiles",
  "salon_members",
  "superadmins",
  "superadmin_audit_logs",
] as const;

/** Booking cannot work without these; a missing RPC fails at runtime, not at apply time. */
const CRITICAL_FUNCTIONS = ["compute_no_show_risk"] as const;

const dbUrl = process.env.DB_URL;
if (!dbUrl?.trim()) {
  console.error("check-schema-parity needs DB_URL (from `supabase status -o env`).");
  process.exit(1);
}

function q(sql: string): string {
  return execFileSync("psql", [dbUrl!, "-tAc", sql], { encoding: "utf8" }).trim();
}

function num(sql: string): number {
  return Number.parseInt(q(sql), 10);
}

function main() {
  const actual = {
    tables: num(
      "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'",
    ),
    columns: num(
      "select count(*) from information_schema.columns where table_schema='public'",
    ),
    policies: num("select count(*) from pg_policies where schemaname='public'"),
    functions: num(
      "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'",
    ),
    triggers: num(
      "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal",
    ),
    indexes: num("select count(*) from pg_indexes where schemaname='public'"),
  };

  let failed = false;

  console.log("\n── Schema parity (local vs production) ──\n");
  console.log("  object      local   prod   ");
  for (const key of Object.keys(PRODUCTION) as Array<keyof typeof PRODUCTION>) {
    const got = actual[key];
    const want = PRODUCTION[key];
    const ok = got >= Math.floor(want * TOLERANCE);
    if (!ok) failed = true;
    console.log(
      `  ${ok ? "✓" : "✗"} ${key.padEnd(10)} ${String(got).padStart(5)}  ${String(want).padStart(5)}` +
        (ok ? "" : `   ← short by ${want - got}`),
    );
  }

  console.log("\n── Critical objects ──\n");
  for (const t of CRITICAL_TABLES) {
    const exists = num(
      `select count(*) from information_schema.tables where table_schema='public' and table_name='${t}'`,
    );
    if (!exists) failed = true;
    console.log(`  ${exists ? "✓" : "✗"} table    ${t}`);
  }
  for (const f of CRITICAL_FUNCTIONS) {
    const exists = num(
      `select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='${f}'`,
    );
    if (!exists) failed = true;
    console.log(`  ${exists ? "✓" : "✗"} function ${f}`);
  }

  // RLS enablement is the one that silently ruins a test suite: the tables are
  // there, the specs pass, and nothing is isolated.
  const rlsOff = q(
    `select coalesce(string_agg(c.relname, ', '), '')
       from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and not c.relrowsecurity
        and c.relname in ('salons','bookings','staff','services','client_profiles','salon_members')`,
  );
  if (rlsOff) {
    failed = true;
    console.log(`\n  ✗ RLS is DISABLED on: ${rlsOff}`);
    console.log(
      "    Tenant-isolation specs would pass against a database that isolates nothing.",
    );
  } else {
    console.log("\n  ✓ RLS enabled on every core table");
  }

  console.log(
    failed
      ? "\n✗ The baseline did not reproduce production's schema. Do not trust a green suite on this.\n"
      : "\n✓ Local schema matches production's shape.\n",
  );
  process.exit(failed ? 1 : 0);
}

main();
