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
 * Release shape, measured from production plus the rehearsed forward migrations
 * through 20260807071017. Refresh these with each schema-changing forward
 * migration — they are a tripwire, not a spec.
 */
const PRODUCTION = {
  tables: 105,
  columns: 1404,
  policies: 154,
  /**
   * APP functions only — 112 after the rehearsed forward migrations.
   *
   * Counting every `public` function is a trap: many belong to EXTENSIONS
   * (pgcrypto, btree_gist, pg_trgm, uuid-ossp), which production happens to have
   * installed into `public` while a clean install puts them in `extensions`.
   *
   * The query below excludes anything a `pg_depend` extension edge points at,
   * so extension placement cannot distort this release-shape tripwire.
   */
  functions: 112,
  triggers: 36,
  indexes: 344,
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
  "ai_execution_jobs",
  "ai_execution_worker_state",
  "ai_worker_runs",
  "ai_campaign_manifests",
  "ai_campaign_manifest_recipients",
  "ai_campaign_dispatch_preflights",
  "ai_campaign_dispatch_preflight_decisions",
  "ai_campaign_dispatch_plans",
  "salon_go_live_attestations",
  "salon_client_identity_aliases",
  "salon_client_identity_merge_events",
  "ai_digest_deliveries",
  "ai_agent_permission_audit",
  "ai_usage_events",
  "ai_budget_policies",
  "ai_execution_limits",
] as const;

/** Booking cannot work without these; a missing RPC fails at runtime, not at apply time. */
const CRITICAL_FUNCTIONS = [
  "compute_no_show_risk",
  "claim_ai_execution_jobs",
  "cancel_ineligible_ai_execution_jobs",
  "control_ai_execution_job",
  "control_watchdog_alert",
  "decide_ai_approval_request",
  "decide_ai_approval_request_as_actor",
  "mark_ai_approval_decision_channel",
  "finish_ai_execution_job",
  "execute_ai_operational_note",
  "execute_ai_operational_note_v2",
  "recover_stale_ai_execution_jobs",
  "marketing_audience_candidates",
  "record_ai_audience_preparation",
  "record_ai_campaign_manifest",
  "record_ai_campaign_dispatch_preflight",
  "record_ai_campaign_dispatch_preflight_fresh",
  "record_ai_campaign_preflight_evidence",
  "record_ai_operational_exception_signal",
  "seal_ai_campaign_dispatch_plan",
  "record_ai_execution_worker_heartbeat",
  "record_ai_worker_heartbeat",
  "surface_strategist_operational_note_approval",
  "sync_ai_execution_job_exception",
  "sync_ai_manager_operational_exceptions",
  "ai_tenant_allows_autonomous_execution",
  "ai_cron_worker_supported",
  "suggest_salon_slugs_by_similarity",
  "merge_salon_client_identity",
  "revoke_salon_client_identity_merge",
  "apply_salon_client_identity_alias",
  "record_ai_digest_delivery",
  "reject_ai_agent_permission_audit_mutation",
  "set_ai_agent_permission",
  "release_voice_session_reservation",
  "claim_ai_execution_slot",
  "create_recovered_booking",
  "validate_archived_booking_recovery",
  "protect_archived_booking_recovery_flag",
] as const;

const dbUrl = process.env.DB_URL;
if (!dbUrl?.trim()) {
  console.error(
    "check-schema-parity needs DB_URL (from `supabase status -o env`).",
  );
  process.exit(1);
}

function q(sql: string): string {
  return execFileSync("psql", [dbUrl!, "-tAc", sql], {
    encoding: "utf8",
  }).trim();
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
    const ok = got === want;
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
  // Public booking views are SECURITY INVOKER. Anon therefore reaches narrow
  // base-table columns through the safe views, while bearer-capability,
  // credential, identity-security, and other internal state remains
  // service-role-only. That gap IS the PII/security boundary, and it has to
  // survive into the test database intact.
  //
  // The first dump here was taken with --no-privileges and produced 0 grants.
  // Everything above still went green. That is why this check exists.
  console.log("\n── Grant matrix ──\n");
  const GRANTS = { anon: 57, authenticated: 64, service_role: 111 } as const;
  for (const [role, want] of Object.entries(GRANTS)) {
    const got = num(
      `select count(distinct table_name) from (
         select table_name from information_schema.role_table_grants
          where table_schema='public' and grantee='${role}'
         union
         select table_name from information_schema.role_column_grants
          where table_schema='public' and grantee='${role}'
       ) reachable_tables`,
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
