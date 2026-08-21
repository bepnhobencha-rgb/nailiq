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
 * through 20260820105820, plus the additive 20260820123000 confirmation retry
 * and 20260820131500 customer transition email contracts, plus the additive
 * 20260820140000 booking-management, 20260820143000 waitlist-capability and
 * 20260820150000 authoritative payment-operation contracts and the default-off
 * 20260820180036 authoritative booking-service sequence contract and the
 * 20260820211503 authoritative financial report read contract and the default-off
 * 20260820223000 Square optional-capability operation/webhook contract, the
 * 20260820230000 active-auth-session validator and the 20260820233000
 * role-scoped salon operational projection/settings loaders and the
 * 20260820234500 durable SMS consent suppression contract and the
 * 20260821000752 booking vacation/resource write guard, the
 * 20260821003000 immutable booking-confirmation dispatch envelopes and the
 * 20260821003932 durable staff-action notification outbox. Refresh these with
 * each schema-changing forward migration — they
 * are a tripwire, not a spec.
 */
const PRODUCTION = {
  tables: 136,
  // +2 from 20260815190000_add_salon_closure_notice.sql: closure_notice
  // added to both salons (base table) and public_salon_profiles (view) —
  // both count as columns in information_schema.
  // +3 booking pricing evidence columns and +13 owner-notification claim columns
  // (including the deterministic event occurrence key).
  // +15 tokenized booking_notifications columns and +10 delivery-event columns.
  // +7 protected booking transition columns and +53 outbox/event columns.
  // +131 action-state/capability/receipt/group/card/waitlist-delivery columns.
  // +80 payment ledger, replay/create-binding, hosted/public Square capability,
  // and desk cancellation/refund saga columns.
  // +42 sequence catalog/parent/segment/add-on, QA allowlist and durable OTP
  // consumed-booking binding columns.
  // +47 safe columns from the authenticated operational salon view.
  // +48 SMS consent configuration, event, provider-state and salon-state
  // columns (including information_schema-visible generated/view shape).
  // +9 immutable confirmation dispatch envelope columns.
  // +65 staff-action event, delivery, envelope, receipt and ephemeral capture columns.
  columns: 2033,
  policies: 182,
  /**
   * APP functions only — 270 after the rehearsed forward migrations.
   *
   * Counting every `public` function is a trap: many belong to EXTENSIONS
   * (pgcrypto, btree_gist, pg_trgm, uuid-ossp), which production happens to have
   * installed into `public` while a clean install puts them in `extensions`.
   *
   * The query below excludes anything a `pg_depend` extension edge points at,
   * so extension placement cannot distort this release-shape tripwire.
   */
  functions: 271,
  triggers: 62,
  // Transition/capability PKs, unique keys and focused due/salon indexes.
  indexes: 466,
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
  "platform_release_reviews",
  "platform_announcement_deliveries",
  "owner_booking_notification_claims",
  "booking_notification_delivery_events",
  "booking_confirmation_dispatch_envelopes",
  "customer_booking_transition_email_outbox",
  "customer_booking_transition_email_events",
  "booking_management_action_state",
  "booking_management_group_state",
  "booking_management_capabilities",
  "booking_management_action_receipts",
  "booking_card_management_operations",
  "booking_card_save_operations",
  "waitlist_claim_action_state",
  "waitlist_claim_capabilities",
  "waitlist_claim_action_receipts",
  "waitlist_offer_delivery_outbox",
  "waitlist_offer_promotion_receipts",
  "booking_payment_operations",
  "booking_cancel_deposit_refund_sagas",
  "booking_service_segments",
  "square_feature_operations",
  "square_webhook_inbox",
  "square_sync_cursors",
  "sms_consent_events",
  "sms_consent_provider_states",
  "sms_consent_salon_states",
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
  "complete_existing_owner_registration_setup",
  "merge_salon_client_identity",
  "revoke_salon_client_identity_merge",
  "apply_salon_client_identity_alias",
  "record_ai_digest_delivery",
  "reject_ai_agent_permission_audit_mutation",
  "set_ai_agent_permission",
  "release_voice_session_reservation",
  "claim_ai_execution_slot",
  "create_recovered_booking",
  "financial_json_nonnegative_cents",
  "load_authoritative_financial_report",
  "validate_archived_booking_recovery",
  "protect_archived_booking_recovery_flag",
  "protect_guided_admin_setup_rollout_flag",
  "configure_guided_admin_setup_qa_salon",
  "insert_controlled_after_hours_group_bookings",
  "queue_platform_announcement_deliveries",
  "resolve_public_booking_pricing",
  "quote_public_booking",
  "claim_owner_booking_notification",
  "complete_owner_booking_notification",
  "resolve_group_booking_pricing",
  "quote_group_booking",
  "create_group_bookings",
  "claim_booking_confirmation_delivery",
  "complete_booking_confirmation_delivery",
  "lease_due_booking_confirmation_retries",
  "reconcile_stale_booking_confirmation_claims",
  "track_customer_booking_transition_email_occurrence",
  "load_customer_booking_transition_email_material",
  "activate_customer_booking_transition_email",
  "discover_due_customer_booking_transition_emails",
  "cancel_booking_as_customer_with_transition_email",
  "reschedule_booking_as_customer_with_transition_email",
  "claim_customer_booking_transition_email",
  "complete_customer_booking_transition_email",
  "lease_due_customer_booking_transition_email_retries",
  "reconcile_stale_customer_booking_transition_email_claims",
  "booking_management_current_group_material",
  "refresh_booking_management_group_state",
  "mint_booking_management_capability",
  "exchange_public_booking_card_management_capability",
  "booking_management_cancel_preview",
  "inspect_booking_management_capability",
  "booking_management_apply_individual",
  "confirm_booking_with_management_capability",
  "reschedule_booking_with_management_capability",
  "cancel_booking_with_management_capability",
  "booking_management_apply_group",
  "reschedule_group_booking_with_management_capability",
  "cancel_group_booking_with_management_capability",
  "claim_booking_card_management_operation",
  "complete_booking_card_management_operation",
  "reconcile_stale_booking_card_management_operations",
  "claim_booking_card_save_operation",
  "complete_booking_card_save_operation",
  "reconcile_stale_booking_card_save_operations",
  "ensure_waitlist_offer_delivery_outbox",
  "load_waitlist_offer_delivery_material",
  "mint_waitlist_claim_capability",
  "promote_waitlist_for_freed_slot",
  "promote_waitlist_for_booking",
  "promote_waitlist_entry",
  "advance_waitlist_offer_capabilities",
  "cancel_booking_by_id_with_waitlist_offer",
  "inspect_waitlist_claim_capability",
  "claim_waitlist_with_management_capability",
  "claim_waitlist_offer_delivery",
  "complete_waitlist_offer_delivery",
  "load_booking_payment_operation_material",
  "claim_booking_payment_operation",
  "complete_booking_payment_operation",
  "claim_booking_payment_operation_reconciliation",
  "load_public_deposit_payment_material",
  "public_deposit_request_fingerprint",
  "public_booking_create_request_fingerprint",
  "claim_public_deposit_payment_operation",
  "create_public_booking_with_deposit_payment",
  "attach_public_deposit_provider_intent",
  "claim_public_deposit_finalization",
  "resume_public_deposit_customer_confirmation",
  "bind_public_deposit_payment_operation",
  "discover_due_booking_payment_reconciliations",
  "discover_due_unbound_deposit_compensations",
  "claim_due_unbound_deposit_refund",
  "load_late_cancel_refund_material",
  "claim_late_cancel_refund",
  "sync_booking_cancel_deposit_refund_saga",
  "inspect_booking_cancel_deposit_refund_saga",
  "cancel_booking_with_deposit_refund_saga",
  "claim_booking_square_deposit_link",
  "attach_booking_square_deposit_link",
  "issue_public_square_deposit_capability",
  "claim_public_square_deposit_completion",
  "resolve_booking_sequence_pricing_and_schedule",
  "quote_public_booking_sequence",
  "create_public_booking_sequence",
  "replay_public_booking_sequence",
  "resolve_booking_sequence_reschedule",
  "quote_booking_sequence_reschedule",
  "reschedule_booking_sequence_with_management_capability",
  "quote_booking_sequence_reschedule_for_desk",
  "reschedule_booking_sequence_for_desk",
  "replay_booking_sequence_reschedule_for_desk",
  "load_public_booking_sequence_readiness",
  "load_booking_sequence_receipt",
  "inspect_booking_management_capability_with_sequence",
  "configure_multi_service_booking_qa_salon",
  "square_feature_contract",
  "resolve_square_feature_operation_material",
  "claim_square_feature_operation",
  "complete_square_feature_operation",
  "reconcile_stale_square_feature_operations",
  "record_square_webhook_event",
  "claim_square_webhook_events",
  "complete_square_webhook_event",
  "current_auth_session_is_active",
  "load_salon_member_operational_profile",
  "load_salon_owner_admin_settings",
  "sms_consent_provider_context",
  "hash_sms_consent_phone",
  "claim_sms_consent_event",
  "record_sms_consent_event",
  "inspect_sms_consent_event",
  "load_sms_outbound_suppression",
  "enforce_booking_operational_capacity_guard",
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
  // Retry hardening removes anon's legacy booking_notifications reachability;
  // the delivery-event audit table is service-role-only.
  const GRANTS = { anon: 55, authenticated: 64, service_role: 141 } as const;
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
