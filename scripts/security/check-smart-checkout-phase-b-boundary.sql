\set ON_ERROR_STOP on

DO $boundary$
DECLARE
  v_table text;
  v_function regprocedure;
  v_bad integer;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'smart_checkout_devices', 'smart_checkout_sessions', 'smart_checkout_lines',
    'smart_checkout_pairing_attempts', 'smart_checkout_webhook_inbox'
  ] LOOP
    IF to_regclass('public.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'Smart Checkout table missing: %', v_table;
    END IF;
    SELECT count(*) INTO v_bad
    FROM pg_catalog.pg_class c
    WHERE c.oid = ('public.' || v_table)::regclass
      AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
    IF v_bad <> 0 THEN
      RAISE EXCEPTION 'Smart Checkout RLS/FORCE RLS missing: %', v_table;
    END IF;
    IF has_table_privilege('anon', 'public.' || v_table,
         'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_table_privilege('authenticated', 'public.' || v_table,
         'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_table_privilege('service_role', 'public.' || v_table,
         'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'Smart Checkout direct write privilege remains: %', v_table;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN (
        'smart_checkout_pairing_attempts', 'smart_checkout_webhook_inbox'
      )
      AND column_name IN (
        'pairing_code', 'raw_pairing_code', 'raw_body', 'raw_payload',
        'signature', 'authorization', 'client_name', 'client_phone',
        'client_email', 'card_number', 'card_nonce'
      )
  ) THEN
    RAISE EXCEPTION 'Smart Checkout Phase B persisted forbidden raw/PII material';
  END IF;

  FOREACH v_function IN ARRAY ARRAY[
    'public.request_smart_checkout_pairing(uuid,uuid,text,text,text,text,text,text,text,text,text,text)'::regprocedure,
    'public.claim_due_smart_checkout_pairings(text,integer,integer)'::regprocedure,
    'public.complete_smart_checkout_pairing(uuid,uuid,text,text,text,text,text)'::regprocedure,
    'public.record_smart_checkout_webhook_event(text,uuid,text,text,timestamp with time zone,text,text,text,text,text,text,text,integer,text,jsonb)'::regprocedure,
    'public.claim_due_smart_checkout_reconciliations(text,integer,integer)'::regprocedure,
    'public.complete_smart_checkout_reconciliation(uuid,uuid,text,text,text,uuid,text,text,text,text,integer,text,text,text,timestamp with time zone,text,text)'::regprocedure
  ] LOOP
    SELECT count(*) INTO v_bad
    FROM pg_catalog.pg_proc p
    WHERE p.oid = v_function
      AND (NOT p.prosecdef
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]);
    IF v_bad <> 0 THEN
      RAISE EXCEPTION 'Smart Checkout RPC definer/search_path mismatch: %', v_function;
    END IF;
    IF has_function_privilege('anon', v_function, 'EXECUTE')
       OR has_function_privilege('authenticated', v_function, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'Smart Checkout RPC ACL mismatch: %', v_function;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.smart_checkout_sessions'::regclass
      AND conname = 'smart_checkout_sessions_paid_receipt_check'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.smart_checkout_sessions'::regclass
      AND conname = 'smart_checkout_sessions_reconcile_lease_check'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.smart_checkout_pairing_attempts'::regclass
      AND conname = 'smart_checkout_pairing_lease_check'
  ) THEN
    RAISE EXCEPTION 'Smart Checkout receipt/lease constraints missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'smart_checkout_sessions_reconcile_due'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'smart_checkout_pairing_due'
  ) THEN
    RAISE EXCEPTION 'Smart Checkout due-work indexes missing';
  END IF;
END
$boundary$;

SELECT 'Smart Checkout Phase B boundary passed' AS result;
