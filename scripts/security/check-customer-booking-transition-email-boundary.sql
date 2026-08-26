\set ON_ERROR_STOP on

DO $check$
DECLARE
  v_fn regprocedure;
  v_def text;
  v_public_execute boolean;
BEGIN
  IF to_regclass('public.customer_booking_transition_email_outbox') IS NULL
     OR to_regclass('public.customer_booking_transition_email_events') IS NULL THEN
    RAISE EXCEPTION 'customer transition outbox tables missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class
    WHERE oid='public.customer_booking_transition_email_outbox'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class
    WHERE oid='public.customer_booking_transition_email_events'::regclass)
     OR (SELECT count(*) FROM pg_policies WHERE schemaname='public'
       AND tablename IN ('customer_booking_transition_email_outbox','customer_booking_transition_email_events')
       AND permissive='RESTRICTIVE')<>2 THEN
    RAISE EXCEPTION 'customer transition outbox RLS boundary missing';
  END IF;
  IF has_table_privilege('anon','public.customer_booking_transition_email_outbox','SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated','public.customer_booking_transition_email_outbox','SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('anon','public.customer_booking_transition_email_events','SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated','public.customer_booking_transition_email_events','SELECT,INSERT,UPDATE,DELETE')
     OR NOT has_table_privilege('service_role','public.customer_booking_transition_email_outbox','SELECT,INSERT,UPDATE,DELETE')
     OR NOT has_table_privilege('service_role','public.customer_booking_transition_email_events','SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('service_role','public.customer_booking_transition_email_outbox','TRUNCATE')
     OR has_table_privilege('service_role','public.customer_booking_transition_email_events','TRUNCATE') THEN
    RAISE EXCEPTION 'customer transition outbox table ACL mismatch';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    to_regprocedure('public.track_customer_booking_transition_email_occurrence()'),
    to_regprocedure('public.load_customer_booking_transition_email_material(uuid,uuid,text,bigint)'),
    to_regprocedure('public.activate_customer_booking_transition_email(uuid,uuid,text,bigint,timestamptz)'),
    to_regprocedure('public.discover_due_customer_booking_transition_emails(integer)'),
    to_regprocedure('public.cancel_booking_as_customer_with_transition_email(uuid)'),
    to_regprocedure('public.reschedule_booking_as_customer_with_transition_email(uuid,timestamptz,timestamptz)'),
    to_regprocedure('public.claim_customer_booking_transition_email(uuid,uuid,text,bigint,text,text)'),
    to_regprocedure('public.complete_customer_booking_transition_email(uuid,uuid,text,text,text,text)'),
    to_regprocedure('public.lease_due_customer_booking_transition_email_retries(integer)'),
    to_regprocedure('public.reconcile_stale_customer_booking_transition_email_claims(integer)')
  ] LOOP
    IF v_fn IS NULL THEN RAISE EXCEPTION 'customer transition RPC missing'; END IF;
    SELECT EXISTS(
      SELECT 1 FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      WHERE p.oid=v_fn::oid AND acl.grantee=0 AND acl.privilege_type='EXECUTE'
    ) INTO v_public_execute;
    IF v_public_execute OR has_function_privilege('anon',v_fn,'EXECUTE')
       OR has_function_privilege('authenticated',v_fn,'EXECUTE')
       OR NOT has_function_privilege('service_role',v_fn,'EXECUTE') THEN
      RAISE EXCEPTION 'customer transition function ACL mismatch: %',v_fn;
    END IF;
    SELECT pg_get_functiondef(v_fn::oid) INTO v_def;
    IF position('SECURITY DEFINER' IN v_def)=0
       OR position('SET search_path TO ''''' IN v_def)=0 THEN
      RAISE EXCEPTION 'customer transition function hardening mismatch: %',v_fn;
    END IF;
  END LOOP;

  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.bookings'::regclass
    AND tgname='track_customer_booking_transition_email_occurrence' AND NOT tgisinternal)
     OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.bookings'::regclass
       AND conname='bookings_customer_transition_email_input_ephemeral_check')
     OR NOT EXISTS(SELECT 1 FROM pg_constraint
       WHERE conrelid='public.customer_booking_transition_email_outbox'::regclass
         AND conname='customer_booking_transition_email_sent_receipt_check')
     OR NOT EXISTS(SELECT 1 FROM pg_index
       WHERE indexrelid='public.idx_customer_booking_transition_email_due'::regclass
         AND indisvalid AND position('retryable_pre_acceptance' IN pg_get_expr(indpred,indrelid))>0)
     OR NOT EXISTS(SELECT 1 FROM pg_constraint
       WHERE conrelid='public.customer_booking_transition_email_outbox'::regclass
         AND conname='customer_booking_transition_email_occurrence_once') THEN
    RAISE EXCEPTION 'customer transition trigger/check/index invariant missing';
  END IF;

  SELECT pg_get_functiondef('public.track_customer_booking_transition_email_occurrence()'::regprocedure) INTO v_def;
  IF position('current_setting(''role'',true)=''service_role''' IN v_def)=0
     OR position('customer_transition_email_requested := false' IN v_def)=0
     OR position('v_now+interval ''30 minutes''' IN v_def)=0
     OR position('''awaiting_activation''' IN v_def)=0 THEN
    RAISE EXCEPTION 'atomic choice/default-inert/post-transition window invariant missing';
  END IF;
  SELECT pg_get_functiondef('public.discover_due_customer_booking_transition_emails(integer)'::regprocedure) INTO v_def;
  IF position('FOR UPDATE SKIP LOCKED' IN v_def)=0
     OR position('o.status=''pending''' IN v_def)=0 THEN
    RAISE EXCEPTION 'initial due discovery concurrency invariant missing';
  END IF;
  SELECT pg_get_functiondef('public.lease_due_customer_booking_transition_email_retries(integer)'::regprocedure) INTO v_def;
  IF position('FOR UPDATE SKIP LOCKED' IN v_def)=0
     OR position('attempt_count=attempt_count+1' IN v_def)=0 THEN
    RAISE EXCEPTION 'retry lease concurrency/bound invariant missing';
  END IF;
END;
$check$;

SELECT 'PASS customer transition email ACL/static boundary' AS result;
