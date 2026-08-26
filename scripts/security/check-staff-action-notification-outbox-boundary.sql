\set ON_ERROR_STOP on

DO $boundary$
DECLARE v_fn regprocedure; v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    to_regprocedure('public.discover_staff_action_notifications_awaiting_material(integer)'),
    to_regprocedure('public.load_staff_action_notification_material(uuid)'),
    to_regprocedure('public.materialize_staff_action_notification_delivery(uuid,text,text,text)'),
    to_regprocedure('public.suppress_unmaterializable_staff_action_delivery(uuid,text)'),
    to_regprocedure('public.lease_due_staff_action_notification_deliveries(integer)'),
    to_regprocedure('public.complete_staff_action_notification_delivery(uuid,uuid,text,text,text,text)'),
    to_regprocedure('public.reconcile_stale_staff_action_notification_deliveries(integer)'),
    to_regprocedure('public.inspect_staff_action_notification_event(uuid,uuid)'),
    to_regprocedure('public.create_public_booking_for_desk_with_staff_notification(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text,uuid,boolean,boolean,integer)'),
    to_regprocedure('public.cancel_booking_with_deposit_refund_saga_for_desk(uuid,uuid,uuid,integer,boolean,boolean,uuid,timestamptz)'),
    to_regprocedure('public.cancel_booking_group_for_desk_with_staff_notification(uuid,uuid,uuid,uuid,boolean,boolean,integer)'),
    to_regprocedure('public.replay_booking_sequence_reschedule_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)'),
    to_regprocedure('public.reschedule_booking_sequence_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)'),
    to_regprocedure('public.offboard_staff_with_durable_notifications(uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer)'),
    to_regprocedure('public.recover_staff_offboarding_with_durable_notifications(uuid,uuid,uuid,uuid,text)')
  ] LOOP
    IF v_fn IS NULL THEN RAISE EXCEPTION 'staff-action RPC missing'; END IF;
    IF has_function_privilege('anon',v_fn,'EXECUTE')
       OR has_function_privilege('authenticated',v_fn,'EXECUTE')
       OR NOT has_function_privilege('service_role',v_fn,'EXECUTE') THEN
      RAISE EXCEPTION 'staff-action RPC ACL mismatch: %',v_fn;
    END IF;
    SELECT pg_get_functiondef(v_fn::oid) INTO v_def;
    IF position('SECURITY DEFINER' IN v_def)=0
       OR position('SET search_path TO ''''' IN v_def)=0 THEN
      RAISE EXCEPTION 'staff-action RPC hardening mismatch: %',v_fn;
    END IF;
  END LOOP;
  IF NOT (SELECT c.relforcerowsecurity FROM pg_class c
      WHERE c.oid='public.staff_offboarding_receipts'::regclass) THEN
    RAISE EXCEPTION 'staff offboarding receipt FORCE RLS missing';
  END IF;
  IF has_table_privilege('authenticated','public.staff','DELETE')
     OR NOT has_table_privilege('service_role','public.staff','DELETE')
     OR EXISTS (
       SELECT 1 FROM pg_policies p
       WHERE p.schemaname='public' AND p.tablename='staff'
         AND p.cmd IN ('DELETE','ALL')
         AND (
           p.roles @> ARRAY['authenticated']::name[]
           OR p.roles @> ARRAY['public']::name[]
         )
     ) THEN
    RAISE EXCEPTION 'staff lifecycle table privilege/policy boundary mismatch';
  END IF;

  IF has_function_privilege('service_role',
       'public.reschedule_booking_sequence_for_desk_pre_staff_outbox(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)'::regprocedure,'EXECUTE')
     OR has_function_privilege('service_role',
       'public.replay_booking_sequence_reschedule_for_desk_pre_staff_outbox(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION 'pre-outbox sequence helpers remain callable';
  END IF;

  FOREACH v_def IN ARRAY ARRAY[
    'staff_action_notification_outbox','staff_action_notification_deliveries',
    'staff_action_notification_envelopes','staff_action_group_cancel_receipts',
    'staff_offboarding_receipts'
  ] LOOP
    IF has_table_privilege('anon','public.'||v_def,'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated','public.'||v_def,'SELECT,INSERT,UPDATE,DELETE')
       OR NOT has_table_privilege('service_role','public.'||v_def,'SELECT')
       OR NOT (SELECT c.relrowsecurity FROM pg_class c
         WHERE c.oid=('public.'||v_def)::regclass) THEN
      RAISE EXCEPTION 'staff-action table ACL/RLS mismatch: %',v_def;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.bookings'::regclass
      AND tgname='zz_capture_staff_action_notification_occurrence' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.bookings'::regclass
      AND tgname='zy_capture_staff_change_notification_occurrence' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.staff_action_notification_envelopes'::regclass
        AND tgname='prevent_staff_action_notification_envelope_update' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.staff_action_notification_deliveries'::regclass
        AND tgname='cleanup_terminal_staff_action_notification_envelope' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.bookings'::regclass
        AND tgname='enforce_active_staff_for_live_single_booking' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.booking_service_segments'::regclass
        AND tgname='enforce_active_staff_for_live_sequence_segment' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.staff'::regclass
        AND tgname='enforce_no_live_assignments_before_staff_deactivation'
        AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid='public.bookings'::regclass
        AND conname='bookings_staff_action_inputs_ephemeral_check') THEN
    RAISE EXCEPTION 'staff-action trigger/ephemeral-input invariant missing';
  END IF;
  IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid='public.staff_action_notification_outbox'::regclass
        AND c.conname='staff_action_notification_outbox_event_type_check'
        AND position('staff_change' IN pg_get_constraintdef(c.oid))>0
    ) THEN
    RAISE EXCEPTION 'staff_change durable event constraint missing';
  END IF;
  IF has_function_privilege('anon',
       'public.staff_offboarding_notification_request_id(uuid,uuid)'::regprocedure,'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.staff_offboarding_notification_request_id(uuid,uuid)'::regprocedure,'EXECUTE')
     OR has_function_privilege('service_role',
       'public.staff_offboarding_notification_request_id(uuid,uuid)'::regprocedure,'EXECUTE')
     OR has_function_privilege('anon',
       'public.capture_staff_change_notification_occurrence()'::regprocedure,'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.capture_staff_change_notification_occurrence()'::regprocedure,'EXECUTE')
     OR has_function_privilege('service_role',
       'public.capture_staff_change_notification_occurrence()'::regprocedure,'EXECUTE')
     OR has_function_privilege('service_role',
       'public.ensure_staff_offboarding_booking_events(uuid,uuid,uuid,uuid,text,jsonb)'::regprocedure,'EXECUTE')
     OR has_function_privilege('service_role',
       'public.enforce_active_staff_for_live_booking()'::regprocedure,'EXECUTE')
     OR has_function_privilege('service_role',
       'public.enforce_no_live_assignments_on_staff_deactivation()'::regprocedure,
       'EXECUTE')
     OR has_function_privilege('service_role',
       'public.offboard_staff_with_durable_notifications_v3_impl(uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer)'::regprocedure,
       'EXECUTE') THEN
    RAISE EXCEPTION 'staff-change internal helper ACL mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
      WHERE schemaname='public' AND tablename='booking_events'
        AND indexname='booking_events_staff_offboarding_request_booking_uidx')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid='public.booking_events'::regclass
        AND conname='booking_events_staff_offboarding_request_check') THEN
    RAISE EXCEPTION 'canonical staff offboarding audit identity missing';
  END IF;

  SELECT pg_get_functiondef(
    'public.capture_staff_change_notification_occurrence()'::regprocedure
  ) INTO v_def;
  IF position('nailiq.staff_change_force_booking_id' IN v_def)=0
     OR position('affected_segment_ids' IN v_def)=0 THEN
    RAISE EXCEPTION 'sequence staff-change capture override missing';
  END IF;

  SELECT pg_get_functiondef(
    'public.complete_staff_action_notification_delivery_unserialized(uuid,uuid,text,text,text,text)'::regprocedure
  ) INTO v_def;
  IF position('retryable_pre_acceptance' IN v_def)=0
     OR position('unclassified_provider_outcome' IN v_def)=0
     OR position('invalid_provider_receipt' IN v_def)=0 THEN
    RAISE EXCEPTION 'provider outcome taxonomy missing';
  END IF;
  SELECT pg_get_functiondef(
    'public.lease_due_staff_action_notification_deliveries(integer)'::regprocedure
  ) INTO v_def;
  IF position('FOR UPDATE OF d SKIP LOCKED' IN v_def)=0
     OR position('dispatch_envelope' IN v_def)=0 THEN
    RAISE EXCEPTION 'tokenized exact-envelope lease missing';
  END IF;
  SELECT pg_get_functiondef(
    'public.offboard_staff_with_durable_notifications(uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer)'::regprocedure
  ) INTO v_def;
  IF position('pg_advisory_xact_lock' IN v_def)=0
     OR position('FOR UPDATE' IN v_def)=0
     OR position('booking_service_segments' IN v_def)=0
     OR position('ORDER BY b.id' IN v_def)=0
     OR position('ORDER BY seg.booking_id,seg.position,seg.id' IN v_def)=0
     OR position('offboard_staff_with_durable_notifications_v3_impl' IN v_def)=0
     OR position('sendSmsReminder' IN v_def)>0
     OR position('emails.send' IN v_def)>0 THEN
    RAISE EXCEPTION 'staff offboarding lock-order wrapper missing';
  END IF;
  SELECT pg_get_functiondef(
    'public.offboard_staff_with_durable_notifications_v3_impl(uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer)'::regprocedure
  ) INTO v_def;
  IF position('ORDER BY s.id FOR UPDATE' IN v_def)=0
     OR position('FOR KEY SHARE' IN v_def)>0
     OR position('staff_action_notification_request_id' IN v_def)=0
     OR position('staff_offboarding_receipts' IN v_def)=0
     OR position('nailiq.sequence_reschedule_booking_id' IN v_def)=0
     OR position('notification_channel_unavailable' IN v_def)=0
     OR position('ensure_staff_offboarding_booking_events' IN v_def)=0
     OR position('too_many_bookings' IN v_def)=0
     OR position('sendSmsReminder' IN v_def)>0
     OR position('emails.send' IN v_def)>0 THEN
    RAISE EXCEPTION 'atomic staff offboarding durable implementation missing';
  END IF;
  SELECT pg_get_functiondef(
    'public.enforce_no_live_assignments_on_staff_deactivation()'::regprocedure
  ) INTO v_def;
  IF position('FROM public.bookings' IN v_def)=0
     OR position('FROM public.booking_service_segments' IN v_def)=0
     OR position('FROM public.salons' IN v_def)=0
     OR position('OLD.status=''active''' IN v_def)=0
     OR position('NEW.status<>''active''' IN v_def)=0
     OR position('NEW.salon_id IS DISTINCT FROM OLD.salon_id' IN v_def)=0
     OR position('staff salon_id is immutable' IN v_def)=0
     OR position('staff_action_notification_caller_is_service_role()' IN v_def)=0
     OR position('staff lifecycle changes require atomic offboarding' IN v_def)=0
     OR position('FOR UPDATE;' IN v_def)>0 THEN
    RAISE EXCEPTION 'staff-side fail-fast assignment invariant missing';
  END IF;
  SELECT pg_get_triggerdef(t.oid) INTO v_def
  FROM pg_trigger t
  WHERE t.tgrelid='public.staff'::regclass
    AND t.tgname='enforce_no_live_assignments_before_staff_deactivation'
    AND NOT t.tgisinternal;
  IF position('BEFORE DELETE OR UPDATE OF status, deleted_at, salon_id' IN v_def)=0 THEN
    RAISE EXCEPTION 'staff salon/status transition trigger coverage missing';
  END IF;
END;$boundary$;

SELECT 'PASS staff-action notification ACL/static boundary' AS result;
