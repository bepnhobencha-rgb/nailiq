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
  /**
   * APP functions only — 65.
   *
   * `select count(*) from pg_proc where nspname='public'` says 253 on production,
   * and that number is a trap: 188 of them belong to EXTENSIONS (pgcrypto,
   * btree_gist, pg_trgm, uuid-ossp), which production happens to have installed
   * into `public` while a clean install puts them in `extensions`. Counting them
   * made the local database look 188 functions short of a schema it had in fact
   * reproduced exactly.
   *
   * Verified on production: 253 total = 188 extension-owned + 65 app-owned.
   * The query below excludes anything a `pg_depend` extension edge points at.
   */
  functions: 65,
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
    // App functions only — exclude anything an extension owns (see PRODUCTION).
    functions: num(
      "select count(*) from pg_proc p " +
        "join pg_namespace n on n.oid=p.pronamespace " +
        "left join pg_depend d on d.objid=p.oid and d.deptype='e' " +
        "where n.nspname='public' and d.objid is null",
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

  // ── Grant matrix ──────────────────────────────────────────────────────────
  // Policies without grants are a locked door in a wall with no doorway: the
  // request never reaches RLS, it dies at "permission denied for table salons".
  // Worse is the other direction — a blanket `GRANT ALL TO anon` would make the
  // test database MORE permissive than production, and the security specs would
  // pass while a real leak went unnoticed.
  //
  // Production, measured: anon and authenticated reach 75 of the 81 tables;
  // service_role reaches all 81. The six anon cannot touch are the sensitive
  // ones (client_ai_summaries, otp_send_log, payment_disputes, rate_limits,
  // salon_clients, scheduled_notifications) — that gap IS the PII protection,
  // and it has to survive into the test database intact.
  //
  // The first dump here was taken with --no-privileges and produced 0 grants.
  // Everything above still went green. That is why this check exists.
  console.log("\n── Grant matrix ──\n");
  const GRANTS = { anon: 75, authenticated: 75, service_role: 81 } as const;
  for (const [role, want] of Object.entries(GRANTS)) {
    const got = num(
      `select count(distinct table_name) from information_schema.role_table_grants
        where table_schema='public' and grantee='${role}'`,
    );
    const ok = got === want;
    if (!ok) failed = true;
    console.log(
      `  ${ok ? "✓" : "✗"} ${role.padEnd(14)} ${String(got).padStart(3)} / ${want} tables` +
        (ok
          ? ""
          : got === 0
            ? "   ← no grants at all: was the dump taken with --no-privileges?"
            : got > want
              ? "   ← MORE permissive than production. The security specs would lie."
              : "   ← fewer than production; requests will die at permission denied"),
    );
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
