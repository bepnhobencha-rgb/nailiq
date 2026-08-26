\set ON_ERROR_STOP on

DO $boundary$
DECLARE v_bad integer; v_pred text;
BEGIN
  IF to_regclass('public.booking_payment_operations') IS NULL THEN
    RAISE EXCEPTION 'booking_payment_operations is missing';
  END IF;
  SELECT count(*) INTO v_bad FROM pg_catalog.pg_class c
  WHERE c.oid='public.booking_payment_operations'::regclass
    AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
  IF v_bad<>0 THEN RAISE EXCEPTION 'payment ledger RLS/FORCE RLS missing'; END IF;

  SELECT count(*) INTO v_bad
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.proname<>'sync_booking_cancel_deposit_refund_saga'
    AND (p.proname LIKE '%booking_payment%' OR p.proname LIKE '%public_deposit%'
      OR p.proname LIKE '%public_booking_create_request%'
      OR p.proname LIKE '%unbound_deposit%' OR p.proname LIKE '%late_cancel_refund%'
      OR p.proname LIKE '%deposit_refund_saga%' OR p.proname LIKE '%square_deposit%')
    AND (NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
      OR has_function_privilege('anon',p.oid,'EXECUTE')
      OR has_function_privilege('authenticated',p.oid,'EXECUTE')
      OR NOT has_function_privilege('service_role',p.oid,'EXECUTE'));
  IF v_bad<>0 THEN RAISE EXCEPTION 'payment RPC ACL/search_path failures: %',v_bad; END IF;

  IF has_function_privilege('service_role','public.sync_booking_cancel_deposit_refund_saga()','EXECUTE')
     OR has_function_privilege('anon','public.sync_booking_cancel_deposit_refund_saga()','EXECUTE')
     OR has_function_privilege('authenticated','public.sync_booking_cancel_deposit_refund_saga()','EXECUTE') THEN
    RAISE EXCEPTION 'saga projection trigger function is directly executable';
  END IF;

  IF has_table_privilege('anon','public.booking_payment_operations','SELECT')
     OR has_table_privilege('authenticated','public.booking_payment_operations','SELECT')
     OR NOT has_table_privilege('service_role','public.booking_payment_operations','SELECT') THEN
    RAISE EXCEPTION 'payment ledger table ACL mismatch';
  END IF;
  IF has_table_privilege('anon','public.booking_cancel_deposit_refund_sagas','SELECT')
     OR has_table_privilege('authenticated','public.booking_cancel_deposit_refund_sagas','SELECT')
     OR NOT has_table_privilege('service_role','public.booking_cancel_deposit_refund_sagas','SELECT') THEN
    RAISE EXCEPTION 'deposit refund saga table ACL mismatch';
  END IF;
  SELECT pg_get_expr(i.indpred,i.indrelid) INTO v_pred
  FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
  WHERE c.relname='booking_payment_operations_late_cancel_occurrence_once';
  IF v_pred IS NULL OR v_pred NOT LIKE '%operation_occurrence_version IS NOT NULL%'
     OR v_pred NOT LIKE '%unknown%' OR v_pred NOT LIKE '%succeeded%' THEN
    RAISE EXCEPTION 'late-cancel occurrence unique predicate mismatch: %',v_pred;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public.bookings'::regclass
      AND conname='bookings_payment_refund_counters_check' AND NOT convalidated)
     OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public.bookings'::regclass
      AND conname='bookings_late_cancel_payment_counters_check' AND NOT convalidated) THEN
    RAISE EXCEPTION 'historical-scan-safe NOT VALID checks missing';
  END IF;
  IF EXISTS(SELECT 1 FROM public.booking_payment_operations
    WHERE length(provider_idempotency_key)>45) THEN
    RAISE EXCEPTION 'provider idempotency key exceeds Square limit';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname='public'
      AND indexname='booking_payment_operations_expired_attempt_due') THEN
    RAISE EXCEPTION 'expired payment attempt due index missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='booking_payment_operations'
      AND column_name='public_request_fingerprint')
     OR NOT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='booking_payment_operations'
      AND column_name='booking_create_fingerprint') THEN
    RAISE EXCEPTION 'public deposit replay/create fingerprints missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public.booking_payment_operations'::regclass
      AND conname='booking_payment_operations_delivery_mode_coherence_check'
      AND NOT convalidated)
     OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public.booking_payment_operations'::regclass
      AND conname='booking_payment_operations_square_link_receipt_check'
      AND NOT convalidated)
     OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid='public.booking_payment_operations'::regclass
      AND conname='booking_payment_operations_public_square_capability_check'
      AND NOT convalidated) THEN
    RAISE EXCEPTION 'Square payment operation coherence checks missing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname='public'
      AND indexname='booking_payment_operations_provider_order_once')
     OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname='public'
      AND indexname='booking_payment_operations_provider_link_once')
     OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_indexes
    WHERE schemaname='public'
      AND indexname='booking_payment_operations_public_square_capability_once') THEN
    RAISE EXCEPTION 'Square provider receipt/capability uniqueness missing';
  END IF;
END
$boundary$;

SELECT 'booking payment operation boundary passed' AS result;
