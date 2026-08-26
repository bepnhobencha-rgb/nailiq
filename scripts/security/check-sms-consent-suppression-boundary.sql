\set ON_ERROR_STOP on

DO $$
DECLARE
  v_table text;
  v_oid oid;
  v_def text;
  v_unexpected text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'sms_consent_events',
    'sms_consent_provider_states',
    'sms_consent_salon_states'
  ] LOOP
    SELECT c.oid INTO v_oid
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = v_table AND c.relkind = 'r';
    IF v_oid IS NULL THEN RAISE EXCEPTION 'missing table %', v_table; END IF;
    IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = v_oid) THEN
      RAISE EXCEPTION 'RLS disabled on %', v_table;
    END IF;
    IF has_table_privilege('public', v_oid, 'SELECT')
       OR has_table_privilege('anon', v_oid, 'SELECT')
       OR has_table_privilege('authenticated', v_oid, 'SELECT')
       OR NOT has_table_privilege('service_role', v_oid, 'SELECT')
    THEN RAISE EXCEPTION 'table ACL mismatch on %', v_table;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_policy p
      WHERE p.polrelid = v_oid
        AND p.polroles = ARRAY['service_role'::regrole::oid]
        AND p.polcmd = '*'
    ) THEN RAISE EXCEPTION 'service-only policy missing on %', v_table;
    END IF;
  END LOOP;

  SELECT pg_catalog.string_agg(table_name || '.' || column_name, ', ')
  INTO v_unexpected
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN (
      'sms_consent_events', 'sms_consent_provider_states',
      'sms_consent_salon_states'
    )
    AND (
      column_name IN ('phone', 'raw_phone', 'message_body', 'body')
      OR column_name LIKE '%auth_token%'
    );
  IF v_unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'raw PII/credential column present: %', v_unexpected;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.sms_consent_events'::regclass
      AND conname = 'sms_consent_events_scope_shape_check'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'sms_consent_events_provider_event_once'
      AND indexdef LIKE '%(provider, provider_event_id)%'
  ) THEN
    RAISE EXCEPTION 'event shape/provider replay uniqueness missing';
  END IF;

  IF has_table_privilege(
    'anon', 'public.platform_settings',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR has_table_privilege(
    'authenticated', 'public.platform_settings',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) OR has_column_privilege(
    'anon', 'public.platform_settings', 'sms_consent_hash_secret', 'SELECT'
  ) OR has_column_privilege(
    'authenticated', 'public.platform_settings',
    'sms_consent_hash_secret', 'SELECT'
  ) THEN RAISE EXCEPTION 'SMS HMAC secret exposed through Data API';
  END IF;

  FOREACH v_oid IN ARRAY ARRAY[
    'public.sms_consent_provider_context()'::regprocedure::oid,
    'public.hash_sms_consent_phone(text)'::regprocedure::oid,
    'public.claim_sms_consent_event(uuid,text,text,text,uuid,text,uuid,text,text,text,text,timestamptz)'::regprocedure::oid,
    'public.record_sms_consent_event(uuid,uuid,text)'::regprocedure::oid,
    'public.inspect_sms_consent_event(uuid)'::regprocedure::oid,
    'public.load_sms_outbound_suppression(uuid,text,uuid)'::regprocedure::oid
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid = v_oid AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=""']::text[]
    ) THEN RAISE EXCEPTION 'function % is not hardened SECURITY DEFINER', v_oid::regprocedure;
    END IF;
    IF has_function_privilege('public', v_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
    THEN RAISE EXCEPTION 'function ACL mismatch on %', v_oid::regprocedure;
    END IF;
  END LOOP;

  SELECT pg_catalog.pg_get_functiondef(
    'public.claim_sms_consent_event(uuid,text,text,text,uuid,text,uuid,text,text,text,text,timestamptz)'::regprocedure
  ) INTO v_def;
  IF position('sms-consent-provider-event:twilio:' IN v_def) = 0
     OR position('already_applied' IN v_def) = 0
     OR position('provider_event_conflict' IN v_def) = 0
     OR position('WHEN p_source = ''twilio_webhook'' THEN v_now' IN v_def) = 0
     OR position('provider_context_mismatch' IN v_def) = 0
     OR position('v_expected_material_fingerprint' IN v_def) = 0
     OR position('SELECT e.* INTO v_existing' IN v_def) >
        position('IF v_context->>''code'' <> ''loaded''' IN v_def)
  THEN RAISE EXCEPTION 'claim replay/material/provider binding drifted';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
    'public.load_sms_outbound_suppression(uuid,text,uuid)'::regprocedure
  ) INTO v_def;
  IF position('provider_context_unavailable' IN v_def) = 0
     OR position('affirmative_consent_not_evaluated' IN v_def) = 0
     OR position('salon_sms_disabled' IN v_def) = 0
     OR position('provider_stop' IN v_def) = 0
     OR position('salon_suppression' IN v_def) = 0
  THEN RAISE EXCEPTION 'fail-closed suppression loader drifted';
  END IF;
END;
$$;

SELECT 'sms consent suppression boundary passed' AS result;
