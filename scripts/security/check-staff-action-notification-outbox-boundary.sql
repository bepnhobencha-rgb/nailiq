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
    to_regprocedure('public.reschedule_booking_sequence_for_desk(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)')
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

  IF has_function_privilege('service_role',
       'public.reschedule_booking_sequence_for_desk_pre_staff_outbox(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)'::regprocedure,'EXECUTE')
     OR has_function_privilege('service_role',
       'public.replay_booking_sequence_reschedule_for_desk_pre_staff_outbox(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION 'pre-outbox sequence helpers remain callable';
  END IF;

  FOREACH v_def IN ARRAY ARRAY[
    'staff_action_notification_outbox','staff_action_notification_deliveries',
    'staff_action_notification_envelopes','staff_action_group_cancel_receipts'
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
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.staff_action_notification_envelopes'::regclass
        AND tgname='prevent_staff_action_notification_envelope_update' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.staff_action_notification_deliveries'::regclass
        AND tgname='cleanup_terminal_staff_action_notification_envelope' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid='public.bookings'::regclass
        AND conname='bookings_staff_action_inputs_ephemeral_check') THEN
    RAISE EXCEPTION 'staff-action trigger/ephemeral-input invariant missing';
  END IF;

  SELECT pg_get_functiondef(
    'public.complete_staff_action_notification_delivery(uuid,uuid,text,text,text,text)'::regprocedure
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
END;$boundary$;

SELECT 'PASS staff-action notification ACL/static boundary' AS result;
