\set ON_ERROR_STOP on
BEGIN;
DROP TABLE public.square_sync_cursors;
DROP TABLE public.square_webhook_inbox;
DROP TABLE public.square_feature_operations;
DROP FUNCTION public.complete_square_webhook_event(uuid,uuid,text,text,text);
DROP FUNCTION public.claim_square_webhook_events(text,integer);
DROP FUNCTION public.record_square_webhook_event(uuid,text,text,timestamptz,text,jsonb,text);
DROP FUNCTION public.reconcile_stale_square_feature_operations(text,integer);
DROP FUNCTION public.complete_square_feature_operation(uuid,uuid,text,text,text,text,text);
DROP FUNCTION public.claim_square_feature_operation(uuid,uuid,text,jsonb,text);
DROP FUNCTION public.resolve_square_feature_operation_material(uuid,text,jsonb);
DROP FUNCTION public.square_feature_contract(uuid,text);
ALTER TABLE public.square_integrations DROP CONSTRAINT square_integrations_oauth_scopes_canonical,
  DROP COLUMN oauth_scopes,DROP COLUMN loyalty_sync_enabled,DROP COLUMN gift_cards_sync_enabled,DROP COLUMN inventory_sync_enabled;
ALTER TABLE public.platform_settings DROP COLUMN square_loyalty_platform_enabled,DROP COLUMN square_gift_cards_platform_enabled,DROP COLUMN square_inventory_platform_enabled;
DROP FUNCTION public.square_oauth_scopes_canonical(text[]);
ROLLBACK;
DO $$ BEGIN
  IF to_regclass('public.square_feature_operations') IS NULL OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='square_integrations' AND column_name='oauth_scopes') THEN RAISE EXCEPTION 'rollback did not restore schema'; END IF;
END $$;
SELECT 'square capability rollback passed' AS result;
