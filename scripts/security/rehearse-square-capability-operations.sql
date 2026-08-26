\set ON_ERROR_STOP on
BEGIN;
SET LOCAL request.jwt.claim.role='service_role';

DO $$
DECLARE
  v_salon uuid:='51240000-0000-4000-8000-000000000001';
  v_request uuid:='51240000-0000-4000-8000-000000000002';
  v_resolved jsonb; v_claim jsonb; v_done jsonb; v_event jsonb; v_inbox jsonb;
  v_fp text; v_token uuid; v_op uuid; v_inbox_id uuid;
BEGIN
  INSERT INTO public.salons(id,slug,name,phone,timezone,currency_code)
  VALUES(v_salon,'square-capability-qa','Square capability QA','+16045550124','UTC','CAD');
  INSERT INTO public.square_integrations(salon_id,merchant_id,location_id,application_id,access_token,environment,enabled,oauth_scopes,inventory_sync_enabled,loyalty_sync_enabled)
  VALUES(v_salon,'merchant_qa','location_qa','application_qa','secret-not-returned','sandbox',true,ARRAY['INVENTORY_READ','INVENTORY_WRITE','ITEMS_READ','LOYALTY_READ','LOYALTY_WRITE'],true,true);

  IF public.square_feature_contract(v_salon,'inventory')->>'code'<>'not_ready' THEN RAISE EXCEPTION 'platform default-off failed'; END IF;
  INSERT INTO public.platform_settings(id) VALUES('platform') ON CONFLICT(id) DO NOTHING;
  UPDATE public.platform_settings SET square_inventory_platform_enabled=true,square_loyalty_platform_enabled=true WHERE id='platform';
  v_resolved:=public.resolve_square_feature_operation_material(v_salon,'inventory_catalog_variation_load',
    '{"source_id":"__full_scan__","secondary_id":"__first_page__"}');
  IF v_resolved->>'code'<>'resolved' OR v_resolved->'material'->>'api_version'<>'2026-07-15'
     OR v_resolved->'provider_material'->>'access_token'<>'secret-not-returned' THEN RAISE EXCEPTION 'material contract failed: %',v_resolved; END IF;
  v_fp:=v_resolved->>'material_fingerprint';
  v_claim:=public.claim_square_feature_operation(v_salon,v_request,'inventory_catalog_variation_load',
    '{"source_id":"__full_scan__","secondary_id":"__first_page__"}',v_fp);
  IF v_claim->>'code'<>'operation_claimed' THEN RAISE EXCEPTION 'claim failed'; END IF;
  v_token:=(v_claim->>'attempt_token')::uuid; v_op:=(v_claim->>'operation_id')::uuid;
  v_done:=public.complete_square_feature_operation(v_op,v_token,'succeeded','catalog_read_1','catalog_receipt_1',repeat('a',64),NULL);
  IF v_done->>'code'<>'operation_completed' THEN RAISE EXCEPTION 'complete failed'; END IF;
  IF public.complete_square_feature_operation(v_op,v_token,'succeeded','catalog_read_1','receipt_changed',repeat('a',64),NULL)->>'code'<>'completion_conflict' THEN RAISE EXCEPTION 'changed completion replay accepted'; END IF;
  IF public.claim_square_feature_operation(v_salon,v_request,'inventory_catalog_variation_load',
    '{"source_id":"__full_scan__","secondary_id":"__first_page__"}',v_fp)->>'code'<>'operation_succeeded' THEN RAISE EXCEPTION 'exact claim replay failed'; END IF;
  IF public.claim_square_feature_operation(v_salon,gen_random_uuid(),'inventory_adjustment',
    '{"source_id":"variation_1","quantity":"1.25","from_state":"IN_STOCK","to_state":"SOLD"}',repeat('a',64))->>'code'<>'specialized_inventory_claim_required' THEN RAISE EXCEPTION 'generic Inventory adjustment claim accepted'; END IF;
  IF public.resolve_square_feature_operation_material(v_salon,'inventory_adjustment',
    '{"source_id":"variation_1","quantity":"-1","from_state":"IN_STOCK","to_state":"SOLD"}')->>'code'<>'invalid_inventory_adjustment' THEN RAISE EXCEPTION 'negative inventory accepted'; END IF;
  IF public.resolve_square_feature_operation_material(v_salon,'inventory_adjustment',
    '{"source_id":"variation_1","quantity":"1","from_state":"SOLD_ONLINE","to_state":"IN_STOCK"}')->>'code'<>'invalid_inventory_adjustment' THEN RAISE EXCEPTION 'read-only inventory transition accepted'; END IF;

  v_event:=public.record_square_webhook_event(v_salon,'event_inventory_1','inventory.count.updated','2026-08-20Z','variation_1',
    jsonb_build_object('merchant_id','merchant_qa','application_id','application_qa','environment','sandbox','api_version','2026-07-15','provider_account_fingerprint',v_resolved->'material'->>'provider_account_fingerprint','counts',jsonb_build_array(jsonb_build_object('catalog_object_type','ITEM_VARIATION','catalog_object_id','variation_1','location_id','location_qa','quantity','9.125','state','IN_STOCK'))),repeat('b',64));
  IF v_event->>'code'<>'event_recorded' THEN RAISE EXCEPTION 'event record failed: %',v_event; END IF;
  IF public.record_square_webhook_event(v_salon,'event_inventory_1','inventory.count.updated','2026-08-20Z','variation_1',
    jsonb_build_object('merchant_id','merchant_qa','application_id','application_qa','environment','sandbox','api_version','2026-07-15','provider_account_fingerprint',v_resolved->'material'->>'provider_account_fingerprint','counts','[]'::jsonb),repeat('c',64))->>'code'<>'invalid_inventory_event' THEN RAISE EXCEPTION 'invalid duplicate material accepted'; END IF;
  SELECT x INTO v_inbox FROM public.claim_square_webhook_events('inventory',1) x;
  v_inbox_id:=(v_inbox->>'inbox_id')::uuid; v_token:=(v_inbox->>'claim_token')::uuid;
  IF public.complete_square_webhook_event(v_inbox_id,v_token,'processed',repeat('d',64),NULL)->>'code'<>'event_completed' THEN RAISE EXCEPTION 'event complete failed'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.square_sync_cursors WHERE salon_id=v_salon AND feature='inventory' AND last_event_id='event_inventory_1') THEN RAISE EXCEPTION 'cursor not advanced'; END IF;

  v_event:=public.record_square_webhook_event(v_salon,'event_promotion_1','loyalty.promotion.created','2026-08-20Z','promotion_1',
    jsonb_build_object('merchant_id','merchant_qa','application_id','application_qa','environment','sandbox','api_version','2026-07-15','provider_account_fingerprint',v_resolved->'material'->>'provider_account_fingerprint','promotion_id','promotion_1'),repeat('e',64));
  IF v_event->>'code'<>'event_recorded' THEN RAISE EXCEPTION 'loyalty promotion webhook rejected: %',v_event; END IF;

  -- Official catalog.version.updated carries
  -- data.object.catalog_version.updated_at (RFC3339), never a numeric version.
  v_event:=public.record_square_webhook_event(v_salon,'event_catalog_1','catalog.version.updated','2026-08-20T10:15:31Z','catalog',
    jsonb_build_object('merchant_id','merchant_qa','application_id','application_qa','environment','sandbox','api_version','2026-07-15','provider_account_fingerprint',v_resolved->'material'->>'provider_account_fingerprint','catalog_updated_at','2026-08-20T10:15:30.123Z'),repeat('f',64));
  IF v_event->>'code'<>'event_recorded' THEN RAISE EXCEPTION 'official catalog event rejected: %',v_event; END IF;
  IF public.record_square_webhook_event(v_salon,'event_catalog_1','catalog.version.updated','2026-08-20T10:15:31Z','catalog',
    jsonb_build_object('merchant_id','merchant_qa','application_id','application_qa','environment','sandbox','api_version','2026-07-15','provider_account_fingerprint',v_resolved->'material'->>'provider_account_fingerprint','catalog_updated_at','2026-08-20T10:15:30.123Z'),repeat('f',64))->>'code'<>'event_replay' THEN RAISE EXCEPTION 'catalog replay failed'; END IF;
  IF public.record_square_webhook_event(v_salon,'event_catalog_1','catalog.version.updated','2026-08-20T10:15:31Z','catalog',
    jsonb_build_object('merchant_id','merchant_qa','application_id','application_qa','environment','sandbox','api_version','2026-07-15','provider_account_fingerprint',v_resolved->'material'->>'provider_account_fingerprint','catalog_updated_at','2026-08-20T10:16:30.123Z'),repeat('0',64))->>'code'<>'event_conflict' THEN RAISE EXCEPTION 'changed catalog event did not conflict'; END IF;
  IF public.record_square_webhook_event(v_salon,'event_catalog_numeric','catalog.version.updated','2026-08-20T10:15:31Z','catalog',
    jsonb_build_object('merchant_id','merchant_qa','application_id','application_qa','environment','sandbox','api_version','2026-07-15','provider_account_fingerprint',v_resolved->'material'->>'provider_account_fingerprint','catalog_version',123),repeat('1',64))->>'code'<>'invalid_catalog_event' THEN RAISE EXCEPTION 'numeric catalog version fabrication accepted'; END IF;
  IF public.record_square_webhook_event(v_salon,'event_catalog_bad_date','catalog.version.updated','2026-08-20T10:15:31Z','catalog',
    jsonb_build_object('merchant_id','merchant_qa','application_id','application_qa','environment','sandbox','api_version','2026-07-15','provider_account_fingerprint',v_resolved->'material'->>'provider_account_fingerprint','catalog_updated_at','2026-02-30T10:15:30Z'),repeat('2',64))->>'code'<>'invalid_catalog_event' THEN RAISE EXCEPTION 'invalid RFC3339 calendar date accepted'; END IF;

  IF EXISTS(SELECT 1 FROM public.square_feature_operations WHERE material::text LIKE '%secret-not-returned%') THEN RAISE EXCEPTION 'secret persisted'; END IF;
END $$;

ROLLBACK;
SELECT 'square capability behavior passed' AS result;
