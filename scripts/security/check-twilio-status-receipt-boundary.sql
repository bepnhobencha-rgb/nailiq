\set ON_ERROR_STOP on

DO $boundary$
DECLARE
  v_proc regprocedure :=
    'public.record_twilio_message_status_receipt(text,text,text)'::regprocedure;
  v_trigger_proc regprocedure :=
    'public.apply_pending_twilio_receipt_after_correlation()'::regprocedure;
  v_wrapper regprocedure;
  v_internal regprocedure;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public'
      AND c.relname='twilio_message_status_receipts'
      AND c.relrowsecurity
      AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'Twilio receipt inbox is not FORCE RLS';
  END IF;

  IF pg_catalog.has_table_privilege('anon','public.twilio_message_status_receipts','SELECT')
     OR pg_catalog.has_table_privilege('authenticated','public.twilio_message_status_receipts','SELECT')
     OR NOT pg_catalog.has_table_privilege('service_role','public.twilio_message_status_receipts','SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Twilio receipt inbox ACL mismatch';
  END IF;

  IF pg_catalog.has_function_privilege('anon',v_proc,'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated',v_proc,'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role',v_proc,'EXECUTE') THEN
    RAISE EXCEPTION 'Twilio receipt RPC ACL mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc p
    WHERE p.oid=v_proc
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=""']::text[]
  ) THEN
    RAISE EXCEPTION 'Twilio receipt RPC must be SECURITY DEFINER with empty search_path';
  END IF;

  IF pg_catalog.has_function_privilege('anon',v_trigger_proc,'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated',v_trigger_proc,'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role',v_trigger_proc,'EXECUTE') THEN
    RAISE EXCEPTION 'Twilio pending-correlation trigger function ACL mismatch';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc p
    WHERE p.oid=v_trigger_proc
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=""']::text[]
  ) THEN
    RAISE EXCEPTION 'Twilio pending-correlation trigger must be SECURITY DEFINER with empty search_path';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    WHERE NOT t.tgisinternal
      AND p.oid=v_trigger_proc
  ) <> 4 THEN
    RAISE EXCEPTION 'Twilio pending-correlation trigger coverage mismatch';
  END IF;

  FOREACH v_wrapper IN ARRAY ARRAY[
    'public.complete_booking_confirmation_delivery(uuid,uuid,text,text,text,text)'::regprocedure,
    'public.complete_staff_action_notification_delivery(uuid,uuid,text,text,text,text)'::regprocedure,
    'public.complete_review_request_sms_notification(uuid,text,text,text)'::regprocedure,
    'public.record_twilio_review_request_status_receipt(uuid,text,text,text)'::regprocedure
  ] LOOP
    IF pg_catalog.has_function_privilege('anon',v_wrapper,'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated',v_wrapper,'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role',v_wrapper,'EXECUTE')
       OR NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_proc p
         WHERE p.oid=v_wrapper
           AND p.prosecdef
           AND p.proconfig @> ARRAY['search_path=""']::text[]
       ) THEN
      RAISE EXCEPTION 'Twilio completion/correlation wrapper boundary mismatch: %', v_wrapper;
    END IF;
  END LOOP;

  FOREACH v_internal IN ARRAY ARRAY[
    'public.complete_booking_confirmation_delivery_unserialized(uuid,uuid,text,text,text,text)'::regprocedure,
    'public.complete_staff_action_notification_delivery_unserialized(uuid,uuid,text,text,text,text)'::regprocedure
  ] LOOP
    IF pg_catalog.has_function_privilege('anon',v_internal,'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated',v_internal,'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role',v_internal,'EXECUTE') THEN
      RAISE EXCEPTION 'Twilio private completion classifier is externally executable: %', v_internal;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='twilio_message_status_receipts'
      AND column_name IN (
        'phone','client_phone','email','client_email','body','message_body','recipient'
      )
  ) THEN
    RAISE EXCEPTION 'Twilio receipt inbox contains a raw contact/message column';
  END IF;
END;
$boundary$;

SELECT 'twilio_status_receipt_acl_boundary_pass' AS result;
