\set ON_ERROR_STOP on

DO $boundary$
DECLARE
  v_def text;
BEGIN
  IF pg_catalog.has_function_privilege(
       'anon','public.load_authoritative_financial_report(uuid,uuid,date,date,timestamptz)','EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated','public.load_authoritative_financial_report(uuid,uuid,date,date,timestamptz)','EXECUTE')
     OR NOT pg_catalog.has_function_privilege(
       'service_role','public.load_authoritative_financial_report(uuid,uuid,date,date,timestamptz)','EXECUTE') THEN
    RAISE EXCEPTION 'financial report RPC must be service-role-only';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='load_authoritative_financial_report'
      AND p.prosecdef
      AND pg_catalog.array_to_string(p.proconfig,',')='search_path=""'
  ) THEN RAISE EXCEPTION 'financial report RPC SECURITY DEFINER/search_path mismatch'; END IF;
  IF to_regclass('public.salon_financial_metric_policies') IS NOT NULL
     OR to_regclass('public.booking_financial_metric_evidence') IS NOT NULL
     OR to_regclass('public.financial_report_snapshots') IS NOT NULL THEN
    RAISE EXCEPTION 'unsupported/dead financial assertion storage exists';
  END IF;
  SELECT indexdef INTO v_def FROM pg_indexes
  WHERE schemaname='public' AND indexname='booking_payment_operations_unbound_refund_once';
  IF v_def IS NULL OR v_def NOT LIKE '%booking_id IS NULL%'
     OR v_def NOT LIKE '%parent_operation_id%' THEN
    RAISE EXCEPTION 'unbound compensation uniqueness still blocks bound partial refunds: %',v_def;
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public'
      AND indexname='booking_payment_operations_financial_report_occurrence'
      AND indexdef LIKE '%salon_id%completed_at%created_at%'
  ) THEN
    RAISE EXCEPTION 'indexed financial report operation occurrence gate missing';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM pg_indexes WHERE schemaname='public'
      AND indexname='booking_payment_operations_payment_receipt_once'
      AND indexdef LIKE '%provider, provider_account_fingerprint, provider_payment_id%'
  ) OR NOT EXISTS(
    SELECT 1 FROM pg_indexes WHERE schemaname='public'
      AND indexname='booking_payment_operations_refund_receipt_once'
      AND indexdef LIKE '%provider, provider_account_fingerprint, provider_refund_id%'
  ) THEN RAISE EXCEPTION 'provider/account receipt dedupe indexes missing'; END IF;
END;
$boundary$;

SELECT 'authoritative financial report boundary passed' AS result;
