-- Read-only metadata gate. No fixture, provider or live booking mutation.
DO $inbound_boundary$
DECLARE
  v_oid oid; v_signature text; v_service boolean; v_definer boolean;
  v_search_path text[];
BEGIN
  SELECT c.oid INTO v_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='sms_inbound_booking_receipts'
      AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity;
  IF v_oid IS NULL THEN RAISE EXCEPTION 'inbound_receipt_rls_missing'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='sms_inbound_booking_receipts'
      AND grantee IN ('PUBLIC','anon','authenticated','service_role'))
    OR EXISTS (SELECT 1 FROM information_schema.role_column_grants
    WHERE table_schema='public' AND table_name='sms_inbound_booking_receipts'
      AND grantee IN ('PUBLIC','anon','authenticated','service_role')) THEN
    RAISE EXCEPTION 'inbound_receipt_direct_grant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid=v_oid AND t.tgname='sms_inbound_receipts_immutable'
      AND NOT t.tgisinternal AND t.tgenabled='O'
      AND t.tgfoid='public.reject_sms_inbound_receipt_mutation()'::regprocedure
      AND t.tgtype=27) THEN
    RAISE EXCEPTION 'inbound_receipt_immutable_trigger_missing';
  END IF;
  FOR v_signature,v_service,v_definer IN SELECT * FROM (VALUES
    ('public.cancel_booking_from_signed_sms(text,text,text,text,text)',true,true),
    ('public.cancel_booking_with_verified_sms_waitlist(uuid)',false,false),
    ('public.reject_sms_inbound_receipt_mutation()',false,false)
  ) AS expected(signature,service_allowed,definer_required) LOOP
    v_oid := to_regprocedure(v_signature);
    IF v_oid IS NULL THEN RAISE EXCEPTION 'inbound_function_missing'; END IF;
    IF has_function_privilege('anon',v_oid,'EXECUTE')
      OR has_function_privilege('authenticated',v_oid,'EXECUTE')
      OR has_function_privilege('service_role',v_oid,'EXECUTE') IS DISTINCT FROM v_service THEN
      RAISE EXCEPTION 'inbound_function_role_boundary';
    END IF;
    SELECT p.proconfig INTO v_search_path FROM pg_proc p
      WHERE p.oid=v_oid AND p.prosecdef=v_definer;
    IF NOT FOUND OR NOT coalesce(v_search_path @> ARRAY['search_path=""'],false) THEN
      RAISE EXCEPTION 'inbound_function_search_path_or_definer';
    END IF;
  END LOOP;
END;
$inbound_boundary$;
