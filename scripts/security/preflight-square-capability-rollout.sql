\set ON_ERROR_STOP on
DO $$
DECLARE v_rows bigint; v_bytes bigint;
BEGIN
  SELECT count(*),pg_total_relation_size('public.square_integrations') INTO v_rows,v_bytes FROM public.square_integrations;
  RAISE NOTICE 'square_integrations rows=% bytes=%',v_rows,v_bytes;
  IF v_rows>100000 OR v_bytes>1073741824 THEN RAISE EXCEPTION 'square integration rollout budget exceeded'; END IF;
  IF EXISTS(SELECT 1 FROM public.square_integrations WHERE loyalty_sync_enabled OR gift_cards_sync_enabled OR inventory_sync_enabled) THEN RAISE EXCEPTION 'feature must remain default-off before controlled adoption'; END IF;
  IF EXISTS(SELECT 1 FROM public.platform_settings WHERE square_loyalty_platform_enabled OR square_gift_cards_platform_enabled OR square_inventory_platform_enabled) THEN RAISE EXCEPTION 'platform Square capabilities must remain default-off'; END IF;
END $$;
SELECT 'square capability preflight passed' AS result;
