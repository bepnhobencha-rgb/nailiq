\set ON_ERROR_STOP on

BEGIN;
DROP INDEX public.booking_payment_operations_financial_report_occurrence;
DROP INDEX public.booking_payment_operations_unbound_refund_once;
CREATE UNIQUE INDEX booking_payment_operations_unbound_refund_once
  ON public.booking_payment_operations(parent_operation_id)
  WHERE operation_kind='deposit_refund' AND parent_operation_id IS NOT NULL
    AND status IN ('sending','pending_provider','reconciling','unknown','succeeded');
REVOKE EXECUTE ON FUNCTION public.load_authoritative_financial_report(
  uuid,uuid,date,date,timestamptz
) FROM service_role;
DROP FUNCTION public.load_authoritative_financial_report(uuid,uuid,date,date,timestamptz);
DROP FUNCTION public.financial_json_nonnegative_cents(jsonb,text);
ROLLBACK;

DO $schema_verify$
DECLARE
  v_index text;
BEGIN
  IF to_regprocedure(
       'public.load_authoritative_financial_report(uuid,uuid,date,date,timestamp with time zone)'
     ) IS NULL
     OR to_regprocedure('public.financial_json_nonnegative_cents(jsonb,text)') IS NULL
     OR NOT has_function_privilege(
       'service_role',
       'public.load_authoritative_financial_report(uuid,uuid,date,date,timestamptz)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'financial report function/ACL rollback did not restore schema';
  END IF;
  SELECT indexdef INTO v_index FROM pg_indexes
  WHERE schemaname='public' AND indexname='booking_payment_operations_unbound_refund_once';
  IF v_index IS NULL OR v_index NOT LIKE '%booking_id IS NULL%' THEN
    RAISE EXCEPTION 'partial-refund index rollback did not restore forward predicate';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_indexes
    WHERE schemaname='public'
      AND indexname='booking_payment_operations_financial_report_occurrence') THEN
    RAISE EXCEPTION 'report occurrence index rollback did not restore schema';
  END IF;
END;
$schema_verify$;

BEGIN;
INSERT INTO public.service_categories(slug,name_en,name_vi)
VALUES('financial-rollback','Financial rollback','Financial rollback')
ON CONFLICT(slug) DO NOTHING;
INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code)
VALUES('f1120000-0000-4000-8000-000000000001','financial-rollback',
  'Financial rollback','+16045550121','UTC','CAD');
INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
VALUES('f1120000-0000-4000-8000-000000000002',
  'f1120000-0000-4000-8000-000000000001','Financial rollback',1000,30,
  'financial-rollback');
INSERT INTO public.bookings(id,salon_id,service_id,client_name,start_time_utc,
  end_time_utc,status)
VALUES('f1120000-0000-4000-8000-000000000003',
  'f1120000-0000-4000-8000-000000000001',
  'f1120000-0000-4000-8000-000000000002','Rollback client',
  '2026-08-10Z','2026-08-10 00:30Z','completed');
ROLLBACK;

DO $verify$
BEGIN
  IF EXISTS(SELECT 1 FROM public.salons
    WHERE id='f1120000-0000-4000-8000-000000000001')
     OR EXISTS(SELECT 1 FROM public.bookings
    WHERE id='f1120000-0000-4000-8000-000000000003') THEN
    RAISE EXCEPTION 'financial report rehearsal rollback left business rows';
  END IF;
END;
$verify$;

SELECT 'authoritative financial report rollback passed' AS result;
