\set ON_ERROR_STOP on

DO $sequence_boundary$
DECLARE
  v_signature text;
  v_definition text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = 'public.services'::regclass
        AND a.attname = 'prep_minutes' AND a.attnotnull AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = 'public.bookings'::regclass
        AND a.attname = 'schedule_model' AND a.attnotnull AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = 'public.bookings'::regclass
        AND a.attname = 'sequence_version' AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = 'public.platform_settings'::regclass
        AND a.attname = 'multi_service_booking_qa_salon_id' AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = 'public.phone_otp_sessions'::regclass
        AND a.attname = 'consumed_by_booking_id' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'sequence additive columns are incomplete';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
      WHERE c.conrelid='public.phone_otp_sessions'::regclass
        AND c.conname='phone_otp_sessions_consumed_binding_check'
        AND c.contype='c')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
      WHERE c.conrelid='public.phone_otp_sessions'::regclass
        AND c.conname='phone_otp_sessions_consumed_booking_id_fkey'
        AND c.contype='f') THEN
    RAISE EXCEPTION 'OTP consumed-booking binding constraints are incomplete';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid = 'public.booking_service_segments'::regclass
        AND c.relrowsecurity AND c.relforcerowsecurity)
     OR has_table_privilege('anon', 'public.booking_service_segments', 'SELECT')
     OR has_table_privilege('authenticated', 'public.booking_service_segments', 'SELECT')
     OR has_table_privilege('anon', 'public.booking_service_segments', 'INSERT')
     OR has_table_privilege('authenticated', 'public.booking_service_segments', 'UPDATE')
     OR NOT has_table_privilege('service_role', 'public.booking_service_segments', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'segment RLS/table ACL boundary mismatch';
  END IF;

  IF (SELECT count(*) FROM pg_catalog.pg_constraint c
      WHERE c.connamespace = 'public'::regnamespace
        AND c.conname IN (
          'bookings_no_overlap', 'bookings_resource_no_overlap',
          'booking_service_segments_staff_no_overlap',
          'booking_service_segments_resource_no_overlap'
        ) AND c.contype = 'x' AND c.convalidated) <> 4 THEN
    RAISE EXCEPTION 'exact validated exclusion contract is incomplete';
  END IF;
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_definition
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'public.bookings'::regclass AND c.conname = 'bookings_no_overlap';
  IF v_definition NOT LIKE '%schedule_model = ''single''%'
     OR v_definition NOT LIKE '%cancelled%no_show%completed%' THEN
    RAISE EXCEPTION 'single parent staff exclusion predicate mismatch: %', v_definition;
  END IF;
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_definition
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'public.bookings'::regclass
    AND c.conname = 'bookings_resource_no_overlap';
  IF v_definition NOT LIKE '%schedule_model = ''single''%'
     OR v_definition NOT LIKE '%resource_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'single parent resource exclusion predicate mismatch: %', v_definition;
  END IF;
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_definition
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'public.booking_service_segments'::regclass
    AND c.conname = 'booking_service_segments_staff_no_overlap';
  IF v_definition NOT LIKE '%reservation_status%cancelled%no_show%completed%' THEN
    RAISE EXCEPTION 'segment staff exclusion predicate mismatch: %', v_definition;
  END IF;
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO v_definition
  FROM pg_catalog.pg_constraint c
  WHERE c.conrelid = 'public.booking_service_segments'::regclass
    AND c.conname = 'booking_service_segments_resource_no_overlap';
  IF v_definition NOT LIKE '%resource_id IS NOT NULL%'
     OR v_definition NOT LIKE '%reservation_status%cancelled%no_show%completed%' THEN
    RAISE EXCEPTION 'segment resource exclusion predicate mismatch: %', v_definition;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'public.bookings'::regclass
        AND t.tgname = 'enforce_single_booking_capacity_across_models'
        AND NOT t.tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'public.booking_service_segments'::regclass
        AND t.tgname = 'enforce_segment_capacity_across_models'
        AND NOT t.tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'public.booking_service_segments'::regclass
        AND t.tgname = 'check_booking_service_sequence_shape'
        AND t.tgdeferrable AND t.tginitdeferred AND NOT t.tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'public.bookings'::regclass
        AND t.tgname = 'sync_booking_service_segment_status'
        AND NOT t.tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
      WHERE t.tgrelid = 'public.salons'::regclass
        AND t.tgname = 'protect_multi_service_booking_rollout_flag_trigger'
        AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION 'sequence capacity/status/rollout triggers are incomplete';
  END IF;

  IF position('prep_minutes' IN pg_catalog.pg_get_viewdef(
       'public.public_service_catalog'::regclass, true)) = 0 THEN
    RAISE EXCEPTION 'public catalog does not expose prep_minutes';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
    'public.create_public_booking_sequence(jsonb)'::regprocedure
  ) INTO v_definition;
  IF position('otp_session_id' IN v_definition) = 0
     OR position('consumed_by_booking_id = v_booking_id' IN v_definition) = 0
     OR position('FOR UPDATE' IN v_definition) = 0
     OR position('health_acknowledged' IN v_definition) = 0
     OR position('health_ack_at' IN v_definition) = 0
     OR position('sms_consent' IN v_definition) = 0
     OR position('notification_language' IN v_definition) = 0
     OR position('salon_slug' IN v_definition) = 0
     OR position('payment_not_supported' IN v_definition) = 0 THEN
    RAISE EXCEPTION 'sequence create OTP/health/payment atomic boundary incomplete';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
    'public.replay_public_booking_sequence(jsonb)'::regprocedure
  ) INTO v_definition;
  IF position('replay_not_found' IN v_definition)=0
     OR position('public_booking_request_fingerprint' IN v_definition)=0
     OR position('consumed_by_booking_id' IN v_definition)=0
     OR position('sms_consent' IN v_definition)=0
     OR position('notification_language' IN v_definition)=0
     OR position('salon_slug' IN v_definition)=0
     OR position('FOR SHARE' IN v_definition)=0
     OR position('resolve_booking_sequence_pricing_and_schedule' IN v_definition)>0
     OR position('INSERT INTO' IN upper(v_definition))>0
     OR position('UPDATE ' IN upper(v_definition))>0 THEN
    RAISE EXCEPTION 'public sequence replay-only boundary is incomplete or writes';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
    'public.reschedule_booking_sequence_with_management_capability(uuid,uuid,timestamptz,text)'::regprocedure
  ) INTO v_definition;
  IF position('sequence_reschedule_booking_id' IN v_definition)=0
     OR position('SET CONSTRAINTS ALL IMMEDIATE' IN v_definition)=0
     OR position('activate_customer_booking_transition_email' IN v_definition)=0
     OR position('payload_fingerprint' IN v_definition)=0
     OR position('pricing_changed' IN v_definition)=0 THEN
    RAISE EXCEPTION 'canonical whole-sequence reschedule boundary incomplete';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
    'public.reschedule_booking_sequence_for_desk_pre_staff_outbox(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)'::regprocedure
  ) INTO v_definition;
  IF position('salon_members' IN v_definition)=0
     OR position('actor_unauthorized' IN v_definition)=0
     OR position('sequence_reschedule_actor_user_id' IN v_definition)=0
     OR position('sequence_reschedule_notify_sms' IN v_definition)=0
     OR position('booking_management_action_receipts' IN v_definition)=0 THEN
    RAISE EXCEPTION 'tenant/actor-bound desk sequence reschedule boundary incomplete';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
    'public.replay_booking_sequence_reschedule_for_desk_pre_staff_outbox(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)'::regprocedure
  ) INTO v_definition;
  IF position('booking_management_action_receipts' IN v_definition)=0
     OR position('replay_not_found' IN v_definition)=0
     OR position('salon_members' IN v_definition)=0
     OR position('public.bookings' IN v_definition)>0
     OR position('INSERT INTO' IN upper(v_definition))>0
     OR position('UPDATE ' IN upper(v_definition))>0 THEN
    RAISE EXCEPTION 'desk sequence replay-only boundary is incomplete or stateful';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.resolve_booking_sequence_pricing_and_schedule(jsonb,boolean)',
    'public.quote_public_booking_sequence(jsonb)',
    'public.create_public_booking_sequence(jsonb)',
    'public.replay_public_booking_sequence(jsonb)',
    'public.resolve_booking_sequence_reschedule(uuid,uuid,timestamptz,boolean)',
    'public.quote_booking_sequence_reschedule(uuid,uuid,timestamptz)',
    'public.reschedule_booking_sequence_with_management_capability(uuid,uuid,timestamptz,text)',
    'public.quote_booking_sequence_reschedule_for_desk(uuid,uuid,uuid,uuid,timestamptz)',
    'public.reschedule_booking_sequence_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)',
    'public.replay_booking_sequence_reschedule_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)',
    'public.load_public_booking_sequence_readiness(uuid)',
    'public.load_booking_sequence_receipt(uuid,uuid)',
    'public.inspect_booking_management_capability_with_sequence(uuid,text)',
    'public.configure_multi_service_booking_qa_salon(uuid,boolean,text)'
  ] LOOP
    IF has_function_privilege('anon', v_signature, 'EXECUTE')
       OR has_function_privilege('authenticated', v_signature, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_signature, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM pg_catalog.pg_proc p
         CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
           p.proacl, pg_catalog.acldefault('f', p.proowner)
         )) acl
         WHERE p.oid = v_signature::regprocedure
           AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
       )
       OR NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_proc p
         WHERE p.oid = v_signature::regprocedure
           AND p.prosecdef
           AND p.proconfig @> ARRAY['search_path=""']::text[]
       ) THEN
      RAISE EXCEPTION 'sequence RPC ACL/search_path mismatch for %', v_signature;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.salons s
      WHERE lower(trim(s.slug)) IN ('hilite-anaheim', 'hilite-studio')
        AND s.feature_flags @> '{"multi_service_booking_enabled":true}'::jsonb) THEN
    RAISE EXCEPTION 'Hi-Lite salon sequence gate must remain false/missing';
  END IF;
END;
$sequence_boundary$;

SELECT 'booking_service_sequence_boundary_pass' AS result;
