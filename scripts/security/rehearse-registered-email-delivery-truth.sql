\set ON_ERROR_STOP on

BEGIN;

DO $behavior$
DECLARE
  v_occurred timestamptz := transaction_timestamp() - interval '1 minute';
  v_result jsonb;
BEGIN
  v_result := public.record_resend_registered_email_delivery_event(
    'evt-registered-email-delivered',
    'msg-registered-email-1',
    'ai_digest',
    'owner',
    'email.delivered',
    repeat('a', 64),
    2,
    v_occurred,
    repeat('b', 64)
  );
  IF v_result->>'code' <> 'event_applied'
     OR v_result->>'delivery_status' <> 'delivered'
     OR NOT EXISTS (
       SELECT 1
       FROM public.registered_email_delivery_events AS e
       WHERE e.provider_event_id = 'evt-registered-email-delivered'
         AND e.delivery_status = 'delivered'
         AND e.recipient_count = 2
     ) THEN
    RAISE EXCEPTION 'event_applied contract failed: %', v_result;
  END IF;

  v_result := public.record_resend_registered_email_delivery_event(
    'evt-registered-email-delivered',
    'msg-registered-email-1',
    'ai_digest',
    'owner',
    'email.delivered',
    repeat('a', 64),
    2,
    v_occurred,
    repeat('b', 64)
  );
  IF v_result->>'code' <> 'event_replay'
     OR (SELECT count(*) FROM public.registered_email_delivery_events
         WHERE provider_event_id = 'evt-registered-email-delivered') <> 1 THEN
    RAISE EXCEPTION 'event_replay was not idempotent: %', v_result;
  END IF;

  v_result := public.record_resend_registered_email_delivery_event(
    'evt-registered-email-delivered',
    'msg-registered-email-1',
    'ai_digest',
    'owner',
    'email.delivered',
    repeat('a', 64),
    2,
    v_occurred,
    repeat('c', 64)
  );
  IF v_result->>'code' <> 'event_conflict' THEN
    RAISE EXCEPTION 'event_conflict was not raised for changed material: %', v_result;
  END IF;

  v_result := public.record_resend_registered_email_delivery_event(
    'evt-registered-email-sent',
    'msg-registered-email-2',
    'waitlist_offer',
    'customer',
    'email.sent',
    repeat('d', 64),
    1,
    v_occurred,
    repeat('e', 64)
  );
  IF v_result->>'delivery_status' <> 'provider_accepted' THEN
    RAISE EXCEPTION 'provider acceptance was overstated: %', v_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.load_registered_email_delivery_truth(
      'ai_digest', 'owner', 'delivered', 10
    ) AS truth
    WHERE truth.provider_message_id = 'msg-registered-email-1'
  ) THEN
    RAISE EXCEPTION 'PII-free operational projection omitted stored truth';
  END IF;

  v_result := public.record_resend_registered_email_delivery_event(
    'evt-invalid', 'msg-invalid', 'AI Digest', 'owner', 'email.sent',
    repeat('f', 64), 1, v_occurred, repeat('0', 64)
  );
  IF v_result->>'code' <> 'event_rejected' THEN
    RAISE EXCEPTION 'invalid registry key was accepted: %', v_result;
  END IF;
END;
$behavior$;

DO $boundary$
BEGIN
  IF has_table_privilege(
       'anon', 'public.registered_email_delivery_events', 'SELECT,INSERT,UPDATE,DELETE'
     )
     OR has_table_privilege(
       'authenticated', 'public.registered_email_delivery_events', 'SELECT,INSERT,UPDATE,DELETE'
     )
     OR has_table_privilege(
       'service_role', 'public.registered_email_delivery_events', 'SELECT,INSERT,UPDATE,DELETE'
     ) THEN
    RAISE EXCEPTION 'direct table access reopened';
  END IF;

  IF has_function_privilege(
       'anon',
       'public.record_resend_registered_email_delivery_event(text,text,text,text,text,text,integer,timestamptz,text)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.record_resend_registered_email_delivery_event(text,text,text,text,text,text,integer,timestamptz,text)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.record_resend_registered_email_delivery_event(text,text,text,text,text,text,integer,timestamptz,text)'::regprocedure,
       'EXECUTE'
     )
     OR has_function_privilege(
       'anon',
       'public.load_registered_email_delivery_truth(text,text,text,integer)'::regprocedure,
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role',
       'public.load_registered_email_delivery_truth(text,text,text,integer)'::regprocedure,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'registered email delivery RPC ACL mismatch';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'registered_email_delivery_events'
      AND column_name IN (
        'recipient_email', 'email', 'subject', 'html', 'text_body', 'message_body'
      )
  ) THEN
    RAISE EXCEPTION 'raw recipient material appeared';
  END IF;
END;
$boundary$;

ROLLBACK;
