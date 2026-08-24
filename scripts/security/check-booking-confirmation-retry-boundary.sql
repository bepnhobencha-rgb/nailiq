\set ON_ERROR_STOP on

DO $check$
DECLARE
  v_fn regprocedure;
  v_def text;
  v_name text;
  v_public_execute boolean;
  v_cols text[] := ARRAY[
    'attempt_count','attempt_token','claimed_at','updated_at','completed_at',
    'next_attempt_at','expires_at','failure_disposition','provider_name',
    'provider_message_id','payload_fingerprint','recipient_fingerprint',
    'booking_material_fingerprint','completion_fingerprint','reconciliation_reason'
  ];
BEGIN
  FOREACH v_name IN ARRAY v_cols LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'booking_notifications'
        AND column_name = v_name
    ) THEN RAISE EXCEPTION 'missing retry column: %', v_name; END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY[
    to_regprocedure('public.claim_booking_confirmation_delivery(uuid,uuid,text,text,text)'),
    to_regprocedure('public.claim_booking_confirmation_delivery(uuid,uuid,text,text,text,text)'),
    to_regprocedure('public.complete_booking_confirmation_delivery(uuid,uuid,text,text,text,text)'),
    to_regprocedure('public.lease_due_booking_confirmation_retries(integer)'),
    to_regprocedure('public.reconcile_stale_booking_confirmation_claims(integer)')
  ] LOOP
    IF v_fn IS NULL THEN RAISE EXCEPTION 'retry RPC missing'; END IF;
    SELECT EXISTS (
      SELECT 1 FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
      WHERE p.oid=v_fn::oid AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
    ) INTO v_public_execute;
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR v_public_execute
       OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'retry RPC ACL mismatch: %', v_fn;
    END IF;
    SELECT pg_get_functiondef(v_fn::oid) INTO v_def;
    IF position('SECURITY DEFINER' IN v_def) = 0
       OR position('SET search_path TO ''''' IN v_def) = 0 THEN
      RAISE EXCEPTION 'retry RPC hardening mismatch: %', v_fn;
    END IF;
  END LOOP;

  SELECT pg_get_functiondef(
    'public.complete_booking_confirmation_delivery_unserialized(uuid,uuid,text,text,text,text)'::regprocedure
  ) INTO v_def;
  IF position('sms_rate_limited_pre_acceptance' IN v_def) = 0
     OR position('email_rate_limited_pre_acceptance' IN v_def) = 0
     OR position('unclassified_provider_outcome' IN v_def) = 0
     OR position('make_interval(secs => v_jitter_seconds)' IN v_def) = 0
     OR position('p_failure_disposition IS NOT DISTINCT FROM v_disposition' IN v_def) = 0 THEN
    RAISE EXCEPTION 'server-derived completion classification/backoff missing';
  END IF;

  SELECT pg_get_functiondef(
    'public.lease_due_booking_confirmation_retries_without_envelope_legacy(integer)'::regprocedure
  ) INTO v_def;
  IF position('FOR UPDATE SKIP LOCKED' IN v_def) = 0
     OR position('attempt_count = attempt_count + 1' IN v_def) = 0 THEN
    RAISE EXCEPTION 'retry lease lost concurrency/bound invariant';
  END IF;
  SELECT pg_get_functiondef(
    'public.reconcile_stale_booking_confirmation_claims(integer)'::regprocedure
  ) INTO v_def;
  IF position('FOR UPDATE SKIP LOCKED' IN v_def) = 0
     OR position('interval ''15 minutes''' IN v_def) = 0
     OR position('stale_sending_outcome_unknown' IN v_def) = 0 THEN
    RAISE EXCEPTION 'stale reconciler invariant missing';
  END IF;

  IF has_table_privilege('anon', 'public.booking_notifications', 'INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'public.booking_notifications', 'INSERT,UPDATE,DELETE')
     OR NOT has_table_privilege('service_role', 'public.booking_notifications', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_column_privilege('authenticated', 'public.booking_notifications', 'attempt_token', 'SELECT')
     OR has_table_privilege('anon', 'public.booking_notification_delivery_events', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'public.booking_notification_delivery_events', 'SELECT,INSERT,UPDATE,DELETE')
     OR NOT has_table_privilege('service_role', 'public.booking_notification_delivery_events', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('anon', 'public.booking_confirmation_dispatch_envelopes', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'public.booking_confirmation_dispatch_envelopes', 'SELECT,INSERT,UPDATE,DELETE')
     OR NOT has_table_privilege('service_role', 'public.booking_confirmation_dispatch_envelopes', 'SELECT')
     OR has_table_privilege('service_role', 'public.booking_confirmation_dispatch_envelopes', 'INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'retry table/column ACL mismatch';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.booking_notifications'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.booking_notification_delivery_events'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.booking_confirmation_dispatch_envelopes'::regclass)
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies WHERE schemaname='public'
         AND tablename='booking_notification_delivery_events'
         AND permissive='RESTRICTIVE'
     ) OR NOT EXISTS (
       SELECT 1 FROM pg_policies WHERE schemaname='public'
         AND tablename='booking_confirmation_dispatch_envelopes'
         AND permissive='RESTRICTIVE'
     ) THEN RAISE EXCEPTION 'retry RLS boundary missing'; END IF;

  SELECT pg_get_functiondef(
    'public.claim_booking_confirmation_delivery(uuid,uuid,text,text,text,text)'::regprocedure
  ) INTO v_def;
  IF position('octet_length(p_dispatch_envelope) NOT BETWEEN 1 AND 262144' IN v_def)=0
     OR position('extensions.digest(pg_catalog.convert_to(p_dispatch_envelope, ''UTF8''), ''sha256'')' IN v_def)=0
     OR position('recipient_mismatch' IN v_def)=0
     OR position('booking_confirmation_dispatch_envelopes' IN v_def)=0 THEN
    RAISE EXCEPTION 'immutable envelope validation/material binding missing';
  END IF;

  SELECT pg_get_functiondef(
    'public.claim_booking_confirmation_delivery(uuid,uuid,text,text,text)'::regprocedure
  ) INTO v_def;
  IF position('dispatch_envelope_required' IN v_def)=0 THEN
    RAISE EXCEPTION 'material-free legacy claim is not fail closed';
  END IF;

  IF has_function_privilege('service_role',
       'public.claim_booking_confirmation_delivery_without_envelope_legacy(uuid,uuid,text,text,text)'::regprocedure,
       'EXECUTE')
     OR has_function_privilege('service_role',
       'public.lease_due_booking_confirmation_retries_without_envelope_legacy(integer)'::regprocedure,
       'EXECUTE')
     OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgrelid='public.booking_confirmation_dispatch_envelopes'::regclass
         AND tgname='prevent_booking_confirmation_dispatch_envelope_update'
         AND NOT tgisinternal
     ) OR NOT EXISTS (
       SELECT 1 FROM pg_trigger
       WHERE tgrelid='public.booking_notifications'::regclass
         AND tgname='cleanup_terminal_booking_confirmation_dispatch_envelope'
         AND NOT tgisinternal
     ) THEN RAISE EXCEPTION 'private helper/immutability/cleanup boundary missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid='public.booking_notifications_confirmation_once'::regclass
      AND indisunique AND indisvalid
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid='public.idx_booking_notifications_confirmation_retry_due'::regclass
      AND indisvalid
      AND position('retryable_pre_acceptance' IN pg_get_expr(indpred, indrelid)) > 0
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.booking_notification_delivery_events'::regclass
      AND conname='booking_notification_delivery_events_once'
  ) THEN RAISE EXCEPTION 'retry uniqueness/index invariant missing'; END IF;
END;
$check$;

SELECT 'PASS booking confirmation retry ACL/static boundary' AS result;
