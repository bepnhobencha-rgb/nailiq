\set ON_ERROR_STOP on
DO $$
DECLARE v_name text;
BEGIN
  FOREACH v_name IN ARRAY ARRAY[
    'square_feature_operations','square_webhook_inbox','square_sync_cursors',
    'square_loyalty_account_mirrors','square_loyalty_event_mirrors',
    'square_loyalty_reward_mirrors','square_gift_card_mirrors',
    'square_gift_card_activity_mirrors'
  ] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=v_name AND c.relrowsecurity) THEN RAISE EXCEPTION 'RLS missing: %',v_name; END IF;
    IF has_table_privilege('anon','public.'||v_name,'SELECT') OR has_table_privilege('authenticated','public.'||v_name,'SELECT') THEN RAISE EXCEPTION 'public read leaked: %',v_name; END IF;
  END LOOP;
  IF has_table_privilege('service_role','public.square_loyalty_account_mirrors','INSERT,UPDATE,DELETE')
     OR has_table_privilege('service_role','public.square_loyalty_event_mirrors','INSERT,UPDATE,DELETE')
     OR has_table_privilege('service_role','public.square_loyalty_reward_mirrors','INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Square loyalty mirrors allow direct mutation';
  END IF;
  IF has_table_privilege('service_role','public.square_gift_card_mirrors','INSERT,UPDATE,DELETE')
     OR has_table_privilege('service_role','public.square_gift_card_activity_mirrors','INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Square gift card mirrors allow direct mutation';
  END IF;
  FOREACH v_name IN ARRAY ARRAY[
    'square_inventory_catalog_variation_mirrors','square_inventory_retail_mappings',
    'square_inventory_count_event_mirrors','square_inventory_count_mirrors',
    'square_inventory_catalog_sync_state'
  ] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=v_name AND c.relrowsecurity AND c.relforcerowsecurity) THEN RAISE EXCEPTION 'forced inventory RLS missing: %',v_name; END IF;
    IF has_table_privilege('anon','public.'||v_name,'SELECT') OR has_table_privilege('authenticated','public.'||v_name,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_table_privilege('service_role','public.'||v_name,'INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'inventory mirror privilege leaked: %',v_name; END IF;
  END LOOP;
  IF NOT has_table_privilege('authenticated','public.square_inventory_catalog_variation_mirrors','SELECT')
     OR NOT has_table_privilege('authenticated','public.square_inventory_retail_mappings','SELECT')
     OR NOT has_table_privilege('authenticated','public.square_inventory_count_mirrors','SELECT')
     OR has_table_privilege('authenticated','public.square_inventory_count_event_mirrors','SELECT')
     OR has_table_privilege('authenticated','public.square_inventory_catalog_sync_state','SELECT') THEN
    RAISE EXCEPTION 'inventory manager read surface drifted';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['square_feature_contract','resolve_square_feature_operation_material','claim_square_feature_operation','complete_square_feature_operation','reconcile_stale_square_feature_operations','record_square_webhook_event','claim_square_webhook_events','complete_square_webhook_event'] LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=v_name AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE'))) THEN RAISE EXCEPTION 'RPC leaked: %',v_name; END IF;
  END LOOP;
  FOREACH v_name IN ARRAY ARRAY['bind_square_loyalty_subject','apply_square_loyalty_webhook_event'] LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=v_name AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE'))) THEN RAISE EXCEPTION 'Square loyalty RPC leaked: %',v_name; END IF;
  END LOOP;
  FOREACH v_name IN ARRAY ARRAY['bind_square_gift_card_issuance','apply_square_gift_card_webhook_event'] LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=v_name AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE'))) THEN RAISE EXCEPTION 'Square gift card RPC leaked: %',v_name; END IF;
  END LOOP;
  FOREACH v_name IN ARRAY ARRAY['apply_square_inventory_catalog_page','apply_square_inventory_webhook_event'] LOOP
    IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=v_name AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE'))) THEN RAISE EXCEPTION 'Square inventory service RPC leaked: %',v_name; END IF;
  END LOOP;
  IF has_function_privilege('anon','public.confirm_square_inventory_retail_mapping(uuid,uuid,text)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.confirm_square_inventory_retail_mapping(uuid,uuid,text)','EXECUTE')
     OR has_function_privilege('service_role','public.confirm_square_inventory_retail_mapping(uuid,uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Square inventory manual decision RPC role drifted';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='square_feature_operations_provider_receipt_once') THEN RAISE EXCEPTION 'receipt uniqueness missing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='square_integrations_oauth_scopes_canonical' AND convalidated) THEN RAISE EXCEPTION 'OAuth scope constraint not validated'; END IF;
END $$;
SELECT 'square capability boundary passed' AS result;
