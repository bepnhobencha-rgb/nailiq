\set ON_ERROR_STOP on
DO $$
DECLARE v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['square_feature_operations','square_webhook_inbox','square_sync_cursors'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=v_name AND c.relrowsecurity) THEN RAISE EXCEPTION 'RLS missing: %',v_name; END IF;
    IF has_table_privilege('anon','public.'||v_name,'SELECT') OR has_table_privilege('authenticated','public.'||v_name,'SELECT') THEN RAISE EXCEPTION 'public read leaked: %',v_name; END IF;
  END LOOP;
  FOREACH v_name IN ARRAY ARRAY['square_feature_contract','resolve_square_feature_operation_material','claim_square_feature_operation','complete_square_feature_operation','reconcile_stale_square_feature_operations','record_square_webhook_event','claim_square_webhook_events','complete_square_webhook_event'] LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=v_name AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE'))) THEN RAISE EXCEPTION 'RPC leaked: %',v_name; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='square_feature_operations_provider_receipt_once') THEN RAISE EXCEPTION 'receipt uniqueness missing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='square_integrations_oauth_scopes_canonical' AND convalidated) THEN RAISE EXCEPTION 'OAuth scope constraint not validated'; END IF;
END $$;
SELECT 'square capability boundary passed' AS result;
