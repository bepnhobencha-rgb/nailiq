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
 * 20260821003932 durable staff-action notification outbox, the
 * 20260822001500 privacy-minimal availability revision signal, the
 * 20260822023000 batch edge-rate-limit function, and the approved
 * 20260822155809 organization-scoped multi-location contract, plus the
 * 20260822163246 immutable tip and commission-estimate evidence contract, and
 * 20260822165659 PII-free Square Loyalty reconciliation mirrors and the
 * 20260822172547 GAN-free Square Gift Card receipt/activity mirrors, and the
 * 20260822174938 approved retail-only Square Inventory catalog/count mirrors,
 * manual mapping decision contract, and provider latest_time cursor state, plus
 * the 20260822181000 PII-free durable Wix create/lifecycle claim ledgers and
 * signature-verified webhook event inbox, and the 20260822223532,
 * 20260822230102, and 20260822234334 dashboard-only review, promo, and
 * reactivation draft claim contracts, plus the 20260823003401 atomic leased
 * booking-reminder delivery claim contract, the 20260823011500 explicitly
 * environment-gated public Square deposit reconciliation discovery, and the
 * 20260823012836 atomic one-offer-per-salon-session upsell claim contract,
 * the durable Square booking/staff-offboarding hardening through 20260823037200,
 * the hard-OFF 20260823038000 reactivation delivery evidence contract, the
 * 20260823082850 atomic staff-lifecycle browser-write boundary, and the
 * 20260823085905/20260823093507 set-based edge-limiter and positional
 * request-microbatch functions, plus the 20260823110412 signature-verified
 * Square refund webhook inbox and 20260823110500 merchant-scoped Square
 * customer identity map. The 20260823113000 Inventory guard replaces an
 * existing function and therefore does not change shape counts. The
 * 20260823124500/20260823133000 Twilio receipt/correlation migrations add
 * generic and staff-action delivery binding plus SID-first completion wrappers.
 * The 20260823134500 review-SMS migration adds pre-provider claim completion
 * and signed callback-correlation functions. The 20260823171226 cancelled-
 * booking refund migration adds the remaining-deposit claim function.
 * The 20260824234619 V1 terminal-booking policy adds a trigger boundary plus
 * service-only terminal transition and eight-second cancel-undo functions.
 * The 20260825013913 V1 Fast Track staff-capability migration adds one durable
 * salon mode column, two guarded trigger helpers, and one atomic owner/admin
 * capability-replacement function.
 * The 20260825103000 MQA-0148 read-path migration adds one RLS-preserving
 * public booking snapshot plus two service-role-only dashboard projections.
 * The 20260825124500 MQA-0148 dashboard-shell migration adds one
 * service-role-only shell projection.
 * The 20260826235226 group-booking resource migration adds one atomic
 * resource-assignment trigger function and one booking trigger.
 * The 20260827085412/20260827215428 card-continuation migrations add leased
 * response-loss reconciliation plus one PII-free, service-role-only
 * post-commit continuation ledger and two reconciliation functions.
 * The 20260828011125 owner-booking notification migration adds one PII-free,
 * RPC-only durable outbox, its capture trigger, and three service-only worker
 * functions without increasing direct service-role table reachability.
 * The 20260828042657 Resend delivery-truth migration adds two PII-free,
 * RPC-only event/suppression tables, one correlation trigger, and three
 * private/service-only reconciliation functions.
 * The 20260828051308 cancel-email migration adds one service-role-only
 * compatibility handshake for zero-gap code/schema rollout.
 * The 20260828070918 customer-email delivery-truth migration adds two private
 * event/suppression tables, 39 delivery/correlation columns, four private or
 * service-only functions, one recipient-fingerprint trigger and eight indexes.
 * The 20260828172258 booking-OTP delivery-truth migration adds two private
 * PII-free attempt/event tables, one email-code correlation column, four
 * service-only RPCs, two restrictive deny policies and ten indexes.
 * The 20260829024500/20260829033000 V1 no-show safety migrations add one
 * private decision/effect ledger, five service-only RPCs, one restrictive
 * direct-access deny policy and five indexes.
 * The 20260829050000/20260829050100 no-show fee approval migrations add three
 * service-only approval/payment-truth tables, eight private/service-only
 * functions, two immutable-ledger triggers and eighteen indexes. They do not
 * grant direct table access to anon or authenticated.
 * The 20260829063203 queue projection migration adds one service-role-only
 * committed-decision projection without reopening the decision table.
 * The 20260829174542 multi-service card-policy migration adds one
 * service-role-only payment-policy readiness function and replaces the
 * existing sequence readiness/resolver/create definitions in place.
 * Refresh these
 * with each schema-changing forward migration — they
 * are a tripwire, not a spec.
 */
const PRODUCTION = {
  // +1 PII-free Twilio terminal-receipt inbox.
  tables: 186,
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
  // +98 availability-revision, organization/location/staff/customer/loyalty,
  // and financial metric policy/evidence columns, including visible shape.
  // +42 Square Loyalty account/event/reward reconciliation mirror columns.
  // +45 Square Gift Card state/receipt and immutable activity mirror columns.
  // +65 Square Inventory catalog, mapping, count ledger/snapshot and resumable cursor columns.
  // +20 durable Wix create claim/reconciliation columns.
  // +20 durable Wix lifecycle claim/reconciliation columns.
  // +20 signature-verified Wix webhook event inbox columns.
  // +37 dashboard-only review, promo, and reactivation draft claim/approval columns.
  // +14 PII-free booking-reminder delivery claim/lease columns.
  // +11 PII-minimized atomic upsell-session claim columns.
  // +63 PII-free reactivation delivery/authorization/receipt columns.
  // +22 durable Square refund webhook inbox columns and +8 merchant-scoped
  // Square customer identity columns.
  // +4 terminal receipt fields on reminder claims, +4 on staff-action
  // deliveries, and +13 fields in the PII-free Twilio status receipt inbox.
  // +7 fail-closed error-remediation QA and approval evidence columns.
  // +18 card response-loss lease and continuation-ledger columns.
  // +21 owner-booking notification outbox columns.
  // +27 owner-delivery truth, event and suppression columns.
  // +29 booking-OTP delivery attempt/event and email-code correlation columns.
  // +28 no-show decision, undo, commit and effect-lease columns.
  // +66 no-show fee review, immutable approval receipt and Square payment
  // webhook truth columns.
  columns: 2802,
  // The upsell migration replaces two legacy member-write policies with one
  // service-role-only immutable claim policy. The staff-lifecycle hardening
  // removes the browser DELETE policy so hard deletion cannot bypass the
  // service-role-only atomic offboarding contract.
  // +1 restrictive browser-deny policy on the RPC-only owner outbox.
  // +2 restrictive browser-deny policies on delivery truth tables.
  // +2 restrictive browser-deny policies on booking-OTP delivery truth.
  // +1 restrictive direct-access deny policy on no-show decisions.
  policies: 206,
  /**
   * APP functions only — refreshed after the rehearsed forward migrations.
   *
   * Counting every `public` function is a trap: many belong to EXTENSIONS
   * (pgcrypto, btree_gist, pg_trgm, uuid-ossp), which production happens to have
   * installed into `public` while a clean install puts them in `extensions`.
   *
   * The query below excludes anything a `pg_depend` extension edge points at,
   * so extension placement cannot distort this release-shape tripwire.
   */
  // +1 Square discovery, +2 atomic/immutable upsell claim functions, +1
  // positional edge-limiter request-microbatch function, +1 refund webhook
  // recorder, and +1 merchant-scoped customer identity resolver.
  // +1 atomic Twilio terminal-receipt recorder, +1 correlation trigger
  // function, and +2 private completion classifiers retained behind the
  // SID-first service-role wrappers, plus +2 durable review-SMS completion and
  // signed callback-correlation functions.
  // +1 forward-only error-remediation release-gate trigger function.
  // +2 atomic booking-card continuation arm/resolve functions.
  // +4 owner-alert capture, occurrence resolution, claim, and completion functions.
  // +3 delivery-event reconciliation, recorder, and correlation-trigger functions.
  // +1 deferred desk-cancel owner-notification compatibility handshake.
  // +4 booking-OTP attempt, completion, verification and receipt RPCs.
  // +5 no-show begin, undo, finalize, effect-claim and effect-completion RPCs.
  // +8 no-show fee material guards, approval/dispatch RPCs and Square payment
  // webhook reconciliation functions.
  // +1 no-show fee queue decision projection.
  // +1 multi-service booking payment-policy readiness function.
  functions: 412,
  // +4 pending-receipt correlation triggers across notification/staff INSERT
  // and provider-SID transitions.
  // +1 V1 terminal-booking policy trigger.
  // +1 fail-closed error-remediation release-gate trigger.
  // +2 individual/group canonical-create continuation arm triggers.
  // +1 canonical booking owner-alert occurrence trigger.
  // +1 provider-message correlation trigger.
  // +2 no-show fee review/approval immutable-material triggers.
  triggers: 95,
  // Transition/capability PKs, unique keys and focused due/salon indexes.
  // The refund inbox and customer identity map each add PK, unique, and two
  // focused indexes.
  // +1 Twilio inbox primary key plus unique reminder/staff SMS SID indexes.
  // +5 continuation/card-operation PK, unique and due indexes.
  // +2 continuation/card-operation foreign-key support indexes.
  // +4 owner-alert outbox primary, occurrence-unique, due, and salon indexes.
  // +6 delivery truth provider, inbox, pending, salon and suppression indexes.
  // +10 booking-OTP attempt/event/correlation indexes.
  // +5 no-show decision primary, request, booking-state, due and effect indexes.
  // +18 no-show fee review/receipt/webhook primary, unique, lookup and FK indexes.
  indexes: 691,
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
  "owner_booking_notification_outbox",
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
  "resend_owner_delivery_events",
  "owner_email_delivery_suppressions",
  "resend_customer_delivery_events",
  "customer_email_delivery_suppressions",
  "booking_otp_delivery_attempts",
  "resend_booking_otp_delivery_events",
  "booking_no_show_decisions",
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
  "booking_card_management_continuations",
  "waitlist_claim_action_state",
  "waitlist_claim_capabilities",
  "waitlist_claim_action_receipts",
  "waitlist_offer_delivery_outbox",
  "waitlist_offer_promotion_receipts",
  "booking_payment_operations",
  "booking_cancel_deposit_refund_sagas",
  "square_refund_webhook_inbox",
  "booking_service_segments",
  "square_feature_operations",
  "square_webhook_inbox",
  "square_sync_cursors",
  "square_customer_identities",
  "sms_consent_events",
  "sms_consent_provider_states",
  "sms_consent_salon_states",
  "salon_availability_revisions",
  "salon_organizations",
  "salon_organization_members",
  "salon_organization_locations",
  "organization_staff",
  "organization_staff_locations",
  "organization_client_consents",
  "organization_loyalty_programs",
  "organization_loyalty_accounts",
  "organization_loyalty_events",
  "salon_financial_metric_policies",
  "booking_financial_metric_evidence",
  "square_loyalty_account_mirrors",
  "square_loyalty_event_mirrors",
  "square_loyalty_reward_mirrors",
  "square_gift_card_mirrors",
  "square_gift_card_activity_mirrors",
  "square_inventory_catalog_variation_mirrors",
  "square_inventory_retail_mappings",
  "square_inventory_count_event_mirrors",
  "square_inventory_count_mirrors",
  "square_inventory_catalog_sync_state",
  "wix_create_writeback_operations",
  "wix_lifecycle_writeback_operations",
  "wix_webhook_event_inbox",
  "review_reply_draft_claims",
  "promo_campaign_draft_claims",
  "reactivation_campaign_draft_claims",
  "booking_reminder_delivery_claims",
  "twilio_message_status_receipts",
  "ai_upsell_session_claims",
  "reactivation_campaign_deliveries",
  "reactivation_campaign_dispatch_authorizations",
  "reactivation_campaign_delivery_receipts",
  "booking_no_show_fee_reviews",
  "booking_no_show_fee_approval_receipts",
  "square_payment_webhook_inbox",
] as const;

const NO_SHOW_FEE_SERVICE_ONLY_TABLES = [
  "booking_no_show_fee_reviews",
  "booking_no_show_fee_approval_receipts",
  "square_payment_webhook_inbox",
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
  "record_resend_owner_delivery_event",
  "reconcile_resend_owner_delivery_events",
  "reconcile_resend_owner_delivery_on_claim",
  "record_resend_customer_delivery_event",
  "reconcile_resend_customer_delivery_events",
  "customer_email_delivery_suppression_reason",
  "capture_booking_reminder_email_recipient",
  "create_booking_otp_delivery_attempt",
  "complete_booking_otp_delivery_attempt",
  "mark_booking_otp_delivery_verified",
  "record_resend_booking_otp_delivery_event",
  "begin_booking_no_show_v1",
  "undo_booking_no_show_v1",
  "finalize_due_booking_no_shows_v1",
  "claim_booking_no_show_effects_v1",
  "complete_booking_no_show_effects_v1",
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
  "prepare_booking_card_save_dispatch",
  "complete_booking_card_save_operation",
  "reconcile_stale_booking_card_save_operations",
  "complete_booking_card_save_reconciliation",
  "record_booking_card_management_pending",
  "resolve_booking_card_management_continuation",
  "reconcile_due_booking_card_management_continuations",
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
  "discover_due_public_square_deposit_reconciliations",
  "discover_due_unbound_deposit_compensations",
  "claim_due_unbound_deposit_refund",
  "load_late_cancel_refund_material",
  "claim_late_cancel_refund",
  "record_square_refund_webhook_event",
  "sync_booking_cancel_deposit_refund_saga",
  "inspect_booking_cancel_deposit_refund_saga",
  "cancel_booking_with_deposit_refund_saga",
  "claim_cancelled_booking_remaining_deposit_refund",
  "claim_booking_square_deposit_link",
  "attach_booking_square_deposit_link",
  "issue_public_square_deposit_capability",
  "claim_public_square_deposit_completion",
  "resolve_square_customer_identity",
  "booking_sequence_payment_policy_ready",
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
  "auto_assign_single_booking_resource",
  "bump_salon_availability_revision",
  "rate_limit_hit_many",
  "rate_limit_hit_request_batch",
  "load_public_booking_snapshot",
  "load_salon_dashboard_projection",
  "load_owner_home_projection",
  "load_dashboard_shell_projection",
  "protect_organization_staff_location",
  "enforce_organization_staff_time_available",
  "enforce_organization_staff_booking_capacity",
  "enforce_organization_staff_segment_capacity",
  "create_salon_organization",
  "list_organization_clients",
  "apply_organization_loyalty_event",
  "get_organization_booking_report",
  "load_authoritative_financial_report_base_v2",
  "reject_financial_metric_evidence_mutation",
  "configure_salon_financial_metric_policy",
  "record_booking_tip_evidence",
  "calculate_booking_commission_evidence",
  "record_booking_financial_metric_reversal",
  "reject_square_loyalty_event_mutation",
  "bind_square_loyalty_subject",
  "apply_square_loyalty_webhook_event",
  "reject_square_gift_card_activity_mutation",
  "bind_square_gift_card_issuance",
  "apply_square_gift_card_webhook_event",
  "reject_square_inventory_count_event_mutation",
  "confirm_square_inventory_retail_mapping",
  "apply_square_inventory_catalog_page",
  "apply_square_inventory_webhook_event",
  "reconcile_stale_square_inventory_catalog_operations",
  "resolve_wix_create_writeback_material",
  "claim_wix_create_writeback",
  "complete_wix_create_writeback",
  "resolve_wix_lifecycle_writeback_material",
  "claim_wix_lifecycle_writeback",
  "complete_wix_lifecycle_writeback",
  "record_wix_webhook_event",
  "claim_wix_webhook_event",
  "complete_wix_webhook_event",
  "claim_review_reply_draft",
  "complete_review_reply_draft",
  "fail_review_reply_draft",
  "update_review_reply_draft_as_actor",
  "claim_promo_campaign_draft",
  "complete_promo_campaign_draft",
  "fail_promo_campaign_draft",
  "update_promo_campaign_draft_as_actor",
  "create_reactivation_campaign_draft",
  "update_reactivation_campaign_draft_as_actor",
  "marketing_rebook_audience_candidates",
  "record_reactivation_campaign_manifest",
  "claim_booking_reminder_delivery",
  "complete_booking_reminder_delivery",
  "record_twilio_message_status_receipt",
  "apply_pending_twilio_receipt_after_correlation",
  "complete_booking_confirmation_delivery_unserialized",
  "complete_staff_action_notification_delivery",
  "complete_staff_action_notification_delivery_unserialized",
  "complete_review_request_sms_notification",
  "record_twilio_review_request_status_receipt",
  "reject_ai_upsell_session_claim_mutation",
  "claim_ai_upsell_offer",
  "materialize_reactivation_campaign_deliveries",
  "bind_reactivation_campaign_delivery_material",
  "claim_reactivation_campaign_deliveries",
  "complete_reactivation_campaign_delivery",
  "record_reactivation_campaign_delivery_receipt",
  "reconcile_stale_reactivation_campaign_deliveries",
  "enforce_v1_terminal_booking_policy",
  "transition_booking_to_terminal_v1",
  "transition_desk_booking_cancel_with_deferred_owner_v1",
  "undo_recent_cancelled_booking_v1",
  "enforce_staff_capability_write",
  "enforce_staff_capability_mode_transition",
  "set_staff_service_capabilities",
  "track_owner_booking_notification_occurrence",
  "resolve_owner_booking_notification_occurrence",
  "claim_owner_booking_notification_outbox_batch",
  "complete_owner_booking_notification_outbox",
  "prevent_no_show_fee_receipt_mutation",
  "prevent_no_show_fee_review_material_mutation",
  "request_booking_no_show_fee_review",
  "ensure_booking_no_show_fee_review",
  "decide_booking_no_show_fee_review",
  "list_booking_no_show_fee_queue_decisions",
  "authorize_approved_no_show_fee_dispatch",
  "record_approved_no_show_fee_dispatch_outcome",
  "record_square_payment_webhook_event",
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
  // The customer identity map is service-role read-only; the refund inbox is
  // mutation-through-RPC only and intentionally grants no table reachability.
  const GRANTS = { anon: 56, authenticated: 77, service_role: 179 } as const;
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

  console.log("\n── No-show fee service-only boundary ──\n");
  for (const table of NO_SHOW_FEE_SERVICE_ONLY_TABLES) {
    const browserReachable = num(
      `select count(*) from (
         select grantee from information_schema.role_table_grants
          where table_schema='public' and table_name='${table}'
            and grantee in ('anon', 'authenticated')
         union
         select grantee from information_schema.role_column_grants
          where table_schema='public' and table_name='${table}'
            and grantee in ('anon', 'authenticated')
       ) browser_grants`,
    );
    const serviceReachable = num(
      `select count(*) from (
         select grantee from information_schema.role_table_grants
          where table_schema='public' and table_name='${table}'
            and grantee='service_role'
         union
         select grantee from information_schema.role_column_grants
          where table_schema='public' and table_name='${table}'
            and grantee='service_role'
       ) service_grants`,
    );
    const forcedRls = num(
      `select count(*) from pg_class c
         join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relname='${table}'
          and c.relrowsecurity and c.relforcerowsecurity`,
    );
    const ok = browserReachable === 0 && serviceReachable === 1 && forcedRls === 1;
    if (!ok) failed = true;
    console.log(
      `  ${ok ? "✓" : "✗"} ${table}` +
        (ok
          ? ""
          : `   ← browser=${browserReachable}, service_role=${serviceReachable}, force_rls=${forcedRls}`),
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
