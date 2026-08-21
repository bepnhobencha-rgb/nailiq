-- MQA-0124/0125/0127: default-off Square Loyalty, Gift Cards, and Inventory
-- capability boundary. This migration stores no Square access token outside the
-- existing credential table and performs no provider call.
-- Provider requests are intentionally pinned to Square-Version 2026-07-15.
-- This is an explicit compatibility contract, not an alias for "latest";
-- upgrading it requires a reviewed migration plus sandbox contract rehearsal.

ALTER TABLE public.square_integrations
  ADD COLUMN oauth_scopes text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN loyalty_sync_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN gift_cards_sync_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN inventory_sync_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE public.platform_settings
  ADD COLUMN square_loyalty_platform_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN square_gift_cards_platform_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN square_inventory_platform_enabled boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.square_oauth_scopes_canonical(p_scopes text[])
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path TO '' AS $$
  SELECT cardinality(p_scopes)<=64
    AND array_position(p_scopes,NULL) IS NULL
    AND p_scopes=ARRAY(SELECT DISTINCT upper(trim(x)) FROM unnest(p_scopes) x ORDER BY 1)
    AND NOT EXISTS(SELECT 1 FROM unnest(p_scopes) x WHERE x!~'^[A-Z][A-Z0-9_]{1,63}$')
$$;
REVOKE ALL ON FUNCTION public.square_oauth_scopes_canonical(text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.square_oauth_scopes_canonical(text[]) TO service_role;

ALTER TABLE public.square_integrations
  ADD CONSTRAINT square_integrations_oauth_scopes_canonical CHECK (
    public.square_oauth_scopes_canonical(oauth_scopes)
  ) NOT VALID;
ALTER TABLE public.square_integrations
  VALIDATE CONSTRAINT square_integrations_oauth_scopes_canonical;

CREATE TABLE public.square_feature_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  feature text NOT NULL CHECK (feature IN ('loyalty','gift_cards','inventory')),
  operation_kind text NOT NULL CHECK (operation_kind IN (
    'loyalty_program_load','loyalty_account_create','loyalty_event_accumulate',
    'loyalty_reward_create','loyalty_reward_redeem','loyalty_reward_delete',
    'gift_card_create','gift_card_payment','gift_card_activate','gift_card_activity',
    'inventory_catalog_variation_load','inventory_adjustment'
  )),
  parent_operation_id uuid REFERENCES public.square_feature_operations(id),
  provider_account_fingerprint text NOT NULL CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  material_fingerprint text NOT NULL CHECK (material_fingerprint ~ '^[0-9a-f]{64}$'),
  material jsonb NOT NULL CHECK (jsonb_typeof(material)='object' AND pg_column_size(material)<=32768),
  provider_idempotency_key text NOT NULL CHECK (provider_idempotency_key ~ '^nq:[0-9a-f-]{36}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending','sending','pending_provider','reconciling','succeeded','failed','unknown','suppressed'
  )),
  attempt_token uuid,
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2),
  lease_expires_at timestamptz,
  provider_object_id text CHECK (provider_object_id IS NULL OR (length(provider_object_id) BETWEEN 1 AND 255 AND provider_object_id !~ '[[:cntrl:]]')),
  provider_receipt_id text CHECK (provider_receipt_id IS NULL OR (length(provider_receipt_id) BETWEEN 1 AND 255 AND provider_receipt_id !~ '[[:cntrl:]]')),
  result_fingerprint text CHECK (result_fingerprint IS NULL OR result_fingerprint ~ '^[0-9a-f]{64}$'),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(salon_id,request_id)
);
CREATE UNIQUE INDEX square_feature_operations_provider_receipt_once
  ON public.square_feature_operations(provider_account_fingerprint,provider_receipt_id)
  WHERE provider_receipt_id IS NOT NULL;
CREATE INDEX square_feature_operations_due
  ON public.square_feature_operations(feature,status,lease_expires_at,created_at);

CREATE TABLE public.square_webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  provider_account_fingerprint text NOT NULL CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 255 AND event_id !~ '[[:cntrl:]]'),
  event_type text NOT NULL CHECK (event_type IN (
    'loyalty.account.created','loyalty.account.updated','loyalty.account.deleted',
    'loyalty.program.created','loyalty.program.updated','loyalty.event.created',
    'loyalty.promotion.created','loyalty.promotion.updated',
    'gift_card.created','gift_card.updated','gift_card.customer_linked','gift_card.customer_unlinked',
    'gift_card.activity.created','gift_card.activity.updated','catalog.version.updated',
    'inventory.count.updated'
  )),
  feature text NOT NULL CHECK (feature IN ('loyalty','gift_cards','inventory')),
  occurred_at timestamptz NOT NULL,
  entity_id text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 255 AND entity_id !~ '[[:cntrl:]]'),
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  material jsonb NOT NULL CHECK (jsonb_typeof(material)='object' AND pg_column_size(material)<=65536),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','processed','failed','unknown','suppressed')),
  claim_token uuid,
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2),
  lease_expires_at timestamptz,
  result_fingerprint text CHECK (result_fingerprint IS NULL OR result_fingerprint ~ '^[0-9a-f]{64}$'),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,80}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(provider_account_fingerprint,event_id)
);
CREATE INDEX square_webhook_inbox_due
  ON public.square_webhook_inbox(feature,status,received_at);

CREATE TABLE public.square_sync_cursors (
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  feature text NOT NULL CHECK (feature IN ('loyalty','gift_cards','inventory')),
  provider_account_fingerprint text NOT NULL CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  last_event_at timestamptz,
  last_event_id text,
  opaque_cursor text CHECK (opaque_cursor IS NULL OR (length(opaque_cursor)<=2048 AND opaque_cursor !~ '[[:cntrl:]]')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(salon_id,feature)
);

ALTER TABLE public.square_feature_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.square_webhook_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.square_sync_cursors ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.square_feature_operations,public.square_webhook_inbox,public.square_sync_cursors FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.square_feature_operations,public.square_webhook_inbox,public.square_sync_cursors TO service_role;

CREATE OR REPLACE FUNCTION public.square_feature_contract(p_salon_id uuid,p_feature text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_role text:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role',''); v_i public.square_integrations%ROWTYPE; v_required text[]; v_enabled boolean; v_platform boolean:=false; v_fp text;
BEGIN
  IF v_role<>'service_role' THEN RETURN jsonb_build_object('success',false,'code','unauthorized'); END IF;
  IF p_feature NOT IN ('loyalty','gift_cards','inventory') THEN RETURN jsonb_build_object('success',false,'code','invalid_feature'); END IF;
  SELECT * INTO v_i FROM public.square_integrations WHERE salon_id=p_salon_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','integration_not_found'); END IF;
  v_required:=CASE p_feature WHEN 'loyalty' THEN ARRAY['LOYALTY_READ','LOYALTY_WRITE'] WHEN 'gift_cards' THEN ARRAY['GIFTCARDS_READ','GIFTCARDS_WRITE','PAYMENTS_WRITE'] ELSE ARRAY['INVENTORY_READ','INVENTORY_WRITE','ITEMS_READ'] END;
  v_enabled:=CASE p_feature WHEN 'loyalty' THEN v_i.loyalty_sync_enabled WHEN 'gift_cards' THEN v_i.gift_cards_sync_enabled ELSE v_i.inventory_sync_enabled END;
  SELECT CASE p_feature WHEN 'loyalty' THEN ps.square_loyalty_platform_enabled WHEN 'gift_cards' THEN ps.square_gift_cards_platform_enabled ELSE ps.square_inventory_platform_enabled END INTO v_platform FROM public.platform_settings ps WHERE ps.id='platform';
  IF v_i.environment NOT IN ('sandbox','production') OR trim(v_i.merchant_id)='' OR trim(v_i.location_id)='' OR nullif(trim(v_i.application_id),'') IS NULL THEN RETURN jsonb_build_object('success',false,'code','invalid_integration'); END IF;
  v_fp:=encode(extensions.digest(convert_to('2026-07-15'||E'\n'||v_i.environment||E'\n'||v_i.application_id||E'\n'||v_i.merchant_id||E'\n'||v_i.location_id,'UTF8'),'sha256'),'hex');
  RETURN jsonb_build_object('success',true,'code',CASE WHEN v_platform AND v_i.enabled AND v_enabled AND nullif(trim(v_i.access_token),'') IS NOT NULL AND v_required<@v_i.oauth_scopes THEN 'ready' ELSE 'not_ready' END,
    'contract_version',1,'provider','square','api_version','2026-07-15','feature',p_feature,
    'salon_id',p_salon_id,'enabled',v_i.enabled,
    'ready',v_platform AND v_i.enabled AND v_enabled AND nullif(trim(v_i.access_token),'') IS NOT NULL AND v_required<@v_i.oauth_scopes,
    'platform_enabled',v_platform,'feature_enabled',v_enabled,'environment',v_i.environment,'merchant_id',v_i.merchant_id,'location_id',v_i.location_id,
    'application_id',v_i.application_id,'provider_account_fingerprint',v_fp,'required_scopes',to_jsonb(v_required),'granted_scopes',to_jsonb(v_i.oauth_scopes),
    'capabilities',jsonb_build_object(
      'loyalty',v_i.loyalty_sync_enabled AND coalesce((SELECT square_loyalty_platform_enabled FROM public.platform_settings WHERE id='platform'),false),
      'gift_cards',v_i.gift_cards_sync_enabled AND coalesce((SELECT square_gift_cards_platform_enabled FROM public.platform_settings WHERE id='platform'),false),
      'inventory',v_i.inventory_sync_enabled AND coalesce((SELECT square_inventory_platform_enabled FROM public.platform_settings WHERE id='platform'),false)));
END $$;

CREATE OR REPLACE FUNCTION public.resolve_square_feature_operation_material(p_salon_id uuid,p_operation_kind text,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_feature text; v_contract jsonb; v_material jsonb; v_parent public.square_feature_operations%ROWTYPE; v_allowed text[]; v_key text; v_quantity text;
BEGIN
  v_feature:=CASE WHEN p_operation_kind LIKE 'loyalty_%' THEN 'loyalty' WHEN p_operation_kind LIKE 'gift_card_%' THEN 'gift_cards' WHEN p_operation_kind LIKE 'inventory_%' THEN 'inventory' END;
  IF v_feature IS NULL OR jsonb_typeof(p_request)<>'object' THEN RETURN jsonb_build_object('success',false,'code','invalid_request'); END IF;
  v_contract:=public.square_feature_contract(p_salon_id,v_feature);
  IF v_contract->>'code'<>'ready' THEN RETURN v_contract; END IF;
  v_allowed:=ARRAY['source_id','secondary_id','quantity','state','from_state','to_state','parent_operation_id','amount_cents','currency','order_id','payment_source_token'];
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_request) k WHERE NOT k=ANY(v_allowed)) THEN RETURN jsonb_build_object('success',false,'code','invalid_request'); END IF;
  IF nullif(trim(p_request->>'source_id'),'') IS NULL OR length(p_request->>'source_id')>255 OR p_request->>'source_id'~'[[:cntrl:]]' THEN RETURN jsonb_build_object('success',false,'code','invalid_source'); END IF;
  IF p_operation_kind='inventory_adjustment' THEN
    v_quantity:=p_request->>'quantity';
    IF v_quantity IS NULL OR v_quantity!~'^[0-9]{1,12}([.][0-9]{1,5})?$' OR v_quantity::numeric<=0
       OR NOT ((p_request->>'from_state'='NONE' AND p_request->>'to_state'='IN_STOCK')
         OR (p_request->>'from_state'='IN_STOCK' AND p_request->>'to_state' IN ('SOLD','WASTE','NONE'))
         OR (p_request->>'from_state'='UNLINKED_RETURN' AND p_request->>'to_state' IN ('IN_STOCK','WASTE')))
    THEN RETURN jsonb_build_object('success',false,'code','invalid_inventory_adjustment'); END IF;
  END IF;
  IF p_operation_kind IN ('gift_card_payment','gift_card_activate','gift_card_activity','loyalty_reward_redeem','loyalty_reward_delete') THEN
    BEGIN SELECT * INTO v_parent FROM public.square_feature_operations WHERE id=(p_request->>'parent_operation_id')::uuid AND salon_id=p_salon_id; EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('success',false,'code','invalid_parent'); END;
    IF NOT FOUND OR v_parent.status<>'succeeded' OR v_parent.provider_account_fingerprint<>v_contract->>'provider_account_fingerprint' THEN RETURN jsonb_build_object('success',false,'code','parent_not_succeeded'); END IF;
    IF (p_operation_kind='gift_card_payment' AND v_parent.operation_kind<>'gift_card_create') OR (p_operation_kind='gift_card_activate' AND v_parent.operation_kind<>'gift_card_payment') OR (p_operation_kind='gift_card_activity' AND v_parent.operation_kind NOT IN ('gift_card_activate','gift_card_activity')) OR (p_operation_kind LIKE 'loyalty_reward_%' AND v_parent.operation_kind<>'loyalty_reward_create') THEN RETURN jsonb_build_object('success',false,'code','parent_kind_mismatch'); END IF;
    IF p_operation_kind='gift_card_payment' AND ((p_request->>'amount_cents')!~'^[1-9][0-9]{0,5}$' OR (p_request->>'amount_cents')::integer>200000 OR p_request->>'currency'<>'CAD' OR nullif(trim(p_request->>'order_id'),'') IS NULL OR length(p_request->>'order_id')>192 OR nullif(trim(p_request->>'payment_source_token'),'') IS NULL OR length(p_request->>'payment_source_token')>255) THEN RETURN jsonb_build_object('success',false,'code','invalid_payment_material'); END IF;
    IF p_operation_kind='gift_card_activate' AND (p_request->>'amount_cents' IS DISTINCT FROM v_parent.material->>'amount_cents' OR p_request->>'currency' IS DISTINCT FROM v_parent.material->>'currency' OR v_parent.provider_receipt_id IS NULL) THEN RETURN jsonb_build_object('success',false,'code','payment_material_mismatch'); END IF;
  END IF;
  v_material:=jsonb_build_object('contract_version',1,'provider','square','api_version','2026-07-15','feature',v_feature,'operation_kind',p_operation_kind,
    'environment',v_contract->>'environment','merchant_id',v_contract->>'merchant_id','location_id',v_contract->>'location_id',
    'provider_account_fingerprint',v_contract->>'provider_account_fingerprint','source_id',p_request->>'source_id',
    'secondary_id',p_request->>'secondary_id','quantity',p_request->>'quantity','state',p_request->>'state','from_state',p_request->>'from_state','to_state',p_request->>'to_state','amount_cents',p_request->>'amount_cents','currency',p_request->>'currency','order_id',p_request->>'order_id',
    'payment_source_fingerprint',CASE WHEN p_request->>'payment_source_token' IS NULL THEN NULL ELSE encode(extensions.digest(convert_to(p_request->>'payment_source_token','UTF8'),'sha256'),'hex') END,
    'parent_operation_id',CASE WHEN v_parent.id IS NULL THEN NULL ELSE v_parent.id::text END,'parent_provider_object_id',v_parent.provider_object_id);
  RETURN jsonb_build_object('success',true,'code','resolved','feature',v_feature,'provider_material',(v_contract-'success'-'code'-'ready'-'feature_enabled'-'required_scopes'-'granted_scopes')||jsonb_build_object('access_token',(SELECT access_token FROM public.square_integrations WHERE salon_id=p_salon_id),'payment_source_token',p_request->>'payment_source_token','order_id',p_request->>'order_id','amount_cents',p_request->>'amount_cents','currency',p_request->>'currency','autocomplete',true,'accept_partial_authorization',false),
    'material',v_material,'material_fingerprint',encode(extensions.digest(convert_to(v_material::text,'UTF8'),'sha256'),'hex'));
END $$;

CREATE OR REPLACE FUNCTION public.claim_square_feature_operation(p_salon_id uuid,p_request_id uuid,p_operation_kind text,p_request jsonb,p_expected_material_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_role text:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role',''); v_resolved jsonb; v_op public.square_feature_operations%ROWTYPE; v_now timestamptz:=clock_timestamp();
BEGIN
  IF v_role<>'service_role' THEN RETURN jsonb_build_object('success',false,'code','unauthorized'); END IF;
  IF p_request_id IS NULL OR p_expected_material_fingerprint!~'^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('success',false,'code','invalid_request'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_salon_id::text||':'||p_request_id::text,0));
  SELECT * INTO v_op FROM public.square_feature_operations WHERE salon_id=p_salon_id AND request_id=p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_op.operation_kind<>p_operation_kind OR v_op.material_fingerprint<>p_expected_material_fingerprint THEN RETURN jsonb_build_object('success',false,'code','idempotency_conflict'); END IF;
    RETURN jsonb_build_object('success',true,'code',CASE v_op.status WHEN 'succeeded' THEN 'operation_succeeded' WHEN 'sending' THEN 'operation_in_flight' WHEN 'pending_provider' THEN 'reconciliation_required' WHEN 'unknown' THEN 'reconciliation_required' WHEN 'failed' THEN 'operation_failed' ELSE 'operation_pending' END,'operation_id',v_op.id,'status',v_op.status,'provider_object_id',v_op.provider_object_id,'provider_receipt_id',v_op.provider_receipt_id,'material_fingerprint',v_op.material_fingerprint);
  END IF;
  v_resolved:=public.resolve_square_feature_operation_material(p_salon_id,p_operation_kind,p_request);
  IF v_resolved->>'code'<>'resolved' THEN RETURN v_resolved; END IF;
  IF v_resolved->>'material_fingerprint'<>p_expected_material_fingerprint THEN RETURN jsonb_build_object('success',false,'code','material_mismatch'); END IF;
  INSERT INTO public.square_feature_operations(salon_id,request_id,feature,operation_kind,parent_operation_id,provider_account_fingerprint,material_fingerprint,material,provider_idempotency_key,status,attempt_token,attempt_count,lease_expires_at)
  VALUES(p_salon_id,p_request_id,v_resolved->>'feature',p_operation_kind,nullif(p_request->>'parent_operation_id','')::uuid,v_resolved->'material'->>'provider_account_fingerprint',p_expected_material_fingerprint,v_resolved->'material','nq:'||p_request_id::text,'sending',gen_random_uuid(),1,v_now+interval '5 minutes') RETURNING * INTO v_op;
  RETURN jsonb_build_object('success',true,'code','operation_claimed','operation_id',v_op.id,'attempt_token',v_op.attempt_token,'provider_idempotency_key',v_op.provider_idempotency_key,'material',v_op.material,'provider_material',v_resolved->'provider_material','material_fingerprint',v_op.material_fingerprint);
END $$;

CREATE OR REPLACE FUNCTION public.complete_square_feature_operation(p_operation_id uuid,p_attempt_token uuid,p_status text,p_provider_object_id text,p_provider_receipt_id text,p_result_fingerprint text,p_error_code text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_role text:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role',''); v_op public.square_feature_operations%ROWTYPE;
BEGIN
  IF v_role<>'service_role' THEN RETURN jsonb_build_object('success',false,'code','unauthorized'); END IF;
  IF p_status NOT IN ('succeeded','pending_provider','failed','unknown') OR p_result_fingerprint!~'^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('success',false,'code','invalid_completion'); END IF;
  SELECT * INTO v_op FROM public.square_feature_operations WHERE id=p_operation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','operation_not_found'); END IF;
  IF v_op.status IN ('succeeded','failed','unknown') THEN
    IF v_op.status<>p_status OR v_op.provider_object_id IS DISTINCT FROM nullif(trim(p_provider_object_id),'') OR v_op.provider_receipt_id IS DISTINCT FROM nullif(trim(p_provider_receipt_id),'') OR v_op.result_fingerprint IS DISTINCT FROM p_result_fingerprint OR v_op.error_code IS DISTINCT FROM p_error_code THEN RETURN jsonb_build_object('success',false,'code','completion_conflict'); END IF;
    RETURN jsonb_build_object('success',true,'code','completion_replay','status',v_op.status,'provider_object_id',v_op.provider_object_id,'provider_receipt_id',v_op.provider_receipt_id);
  END IF;
  IF v_op.status NOT IN ('sending','reconciling') OR v_op.attempt_token IS DISTINCT FROM p_attempt_token THEN RETURN jsonb_build_object('success',false,'code','claim_mismatch'); END IF;
  IF p_status IN ('succeeded','pending_provider') AND (nullif(trim(p_provider_object_id),'') IS NULL OR nullif(trim(p_provider_receipt_id),'') IS NULL) THEN RETURN jsonb_build_object('success',false,'code','provider_receipt_required'); END IF;
  UPDATE public.square_feature_operations SET status=p_status,provider_object_id=nullif(trim(p_provider_object_id),''),provider_receipt_id=nullif(trim(p_provider_receipt_id),''),result_fingerprint=p_result_fingerprint,error_code=p_error_code,attempt_token=NULL,lease_expires_at=NULL,completed_at=CASE WHEN p_status IN ('succeeded','failed','unknown') THEN clock_timestamp() END,updated_at=clock_timestamp() WHERE id=p_operation_id RETURNING * INTO v_op;
  RETURN jsonb_build_object('success',true,'code','operation_completed','status',v_op.status,'operation_id',v_op.id,'provider_object_id',v_op.provider_object_id,'provider_receipt_id',v_op.provider_receipt_id);
END $$;

CREATE OR REPLACE FUNCTION public.reconcile_stale_square_feature_operations(p_feature text,p_limit integer DEFAULT 25)
RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_role text:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role',''); v_op public.square_feature_operations%ROWTYPE;
BEGIN
  IF v_role<>'service_role' OR p_feature NOT IN ('loyalty','gift_cards','inventory') OR p_limit NOT BETWEEN 1 AND 100 THEN RETURN; END IF;
  FOR v_op IN SELECT * FROM public.square_feature_operations WHERE feature=p_feature AND ((status='sending' AND lease_expires_at<=clock_timestamp()) OR status='pending_provider' OR (status='reconciling' AND lease_expires_at<=clock_timestamp())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT p_limit LOOP
    UPDATE public.square_feature_operations SET status='reconciling',attempt_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '5 minutes',error_code='provider_outcome_requires_reconciliation',updated_at=clock_timestamp() WHERE id=v_op.id RETURNING * INTO v_op;
    RETURN NEXT jsonb_build_object('operation_id',v_op.id,'code','reconciliation_claimed','attempt_token',v_op.attempt_token,'feature',v_op.feature,'operation_kind',v_op.operation_kind,'provider_account_fingerprint',v_op.provider_account_fingerprint,'provider_object_id',v_op.provider_object_id,'provider_receipt_id',v_op.provider_receipt_id,'material',v_op.material,'material_fingerprint',v_op.material_fingerprint);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.record_square_webhook_event(p_salon_id uuid,p_event_id text,p_event_type text,p_occurred_at timestamptz,p_entity_id text,p_material jsonb,p_payload_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_role text:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role',''); v_feature text; v_contract jsonb; v_row public.square_webhook_inbox%ROWTYPE; v_count jsonb; v_catalog_updated_at timestamptz;
BEGIN
  IF v_role<>'service_role' THEN RETURN jsonb_build_object('success',false,'code','unauthorized'); END IF;
  v_feature:=CASE WHEN p_event_type LIKE 'loyalty.%' THEN 'loyalty' WHEN p_event_type LIKE 'gift_card.%' THEN 'gift_cards' WHEN p_event_type IN ('inventory.count.updated','catalog.version.updated') THEN 'inventory' END;
  IF v_feature IS NULL OR p_event_id IS NULL OR length(p_event_id)>255 OR p_entity_id IS NULL OR length(p_entity_id)>255 OR p_payload_fingerprint!~'^[0-9a-f]{64}$' OR jsonb_typeof(p_material)<>'object' OR pg_column_size(p_material)>65536 THEN RETURN jsonb_build_object('success',false,'code','invalid_event'); END IF;
  v_contract:=public.square_feature_contract(p_salon_id,v_feature); IF v_contract->>'code'<>'ready' THEN RETURN v_contract; END IF;
  IF p_material->>'merchant_id' IS DISTINCT FROM v_contract->>'merchant_id' OR p_material->>'application_id' IS DISTINCT FROM v_contract->>'application_id' OR p_material->>'environment' IS DISTINCT FROM v_contract->>'environment' OR p_material->>'api_version' IS DISTINCT FROM '2026-07-15' OR p_material->>'provider_account_fingerprint' IS DISTINCT FROM v_contract->>'provider_account_fingerprint' THEN RETURN jsonb_build_object('success',false,'code','provider_context_mismatch'); END IF;
  IF p_material::text ~* '"(gan|phone_number|access_token|card_number|raw_body)"[[:space:]]*:' THEN RETURN jsonb_build_object('success',false,'code','sensitive_material_rejected'); END IF;
  IF p_event_type='inventory.count.updated' THEN
    IF jsonb_typeof(p_material->'counts')<>'array' OR jsonb_array_length(p_material->'counts') NOT BETWEEN 1 AND 100 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_material->'counts') c WHERE c->>'catalog_object_type'<>'ITEM_VARIATION' OR c->>'location_id' IS DISTINCT FROM v_contract->>'location_id' OR c->>'quantity'!~'^[-]?[0-9]{1,12}([.][0-9]{1,5})?$' OR c->>'state' NOT IN ('CUSTOM','IN_STOCK','SOLD','RETURNED_BY_CUSTOMER','RESERVED_FOR_SALE','SOLD_ONLINE','ORDERED_FROM_VENDOR','RECEIVED_FROM_VENDOR','IN_TRANSIT_TO','IN_TRANSIT','NONE','WASTE','UNLINKED_RETURN','UNTRACKED','COMPOSED','DECOMPOSED','SUPPORTED_BY_NEWER_VERSION')) THEN RETURN jsonb_build_object('success',false,'code','invalid_inventory_event'); END IF;
  ELSIF p_event_type='catalog.version.updated' THEN
    -- Square's catalog.version.updated payload does not carry a numeric
    -- catalog version. Its authoritative cursor fact is
    -- data.object.catalog_version.updated_at, normalized by the verified
    -- webhook boundary to catalog_updated_at. Keep the inbox material narrow
    -- so a caller cannot fabricate a parallel numeric version contract.
    IF p_material ? 'catalog_version'
       OR EXISTS (
         SELECT 1 FROM jsonb_object_keys(p_material) AS k(key)
         WHERE k.key NOT IN (
           'merchant_id','application_id','environment','api_version',
           'provider_account_fingerprint','catalog_updated_at'
         )
       )
       OR jsonb_typeof(p_material->'catalog_updated_at')<>'string'
       OR (p_material->>'catalog_updated_at') !~
          '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,9})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$'
    THEN
      RETURN jsonb_build_object('success',false,'code','invalid_catalog_event');
    END IF;
    BEGIN
      v_catalog_updated_at := (p_material->>'catalog_updated_at')::timestamptz;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
      RETURN jsonb_build_object('success',false,'code','invalid_catalog_event');
    END;
    IF v_catalog_updated_at IS NULL THEN
      RETURN jsonb_build_object('success',false,'code','invalid_catalog_event');
    END IF;
  END IF;
  INSERT INTO public.square_webhook_inbox(salon_id,provider_account_fingerprint,event_id,event_type,feature,occurred_at,entity_id,payload_fingerprint,material)
  VALUES(p_salon_id,v_contract->>'provider_account_fingerprint',p_event_id,p_event_type,v_feature,p_occurred_at,p_entity_id,p_payload_fingerprint,p_material)
  ON CONFLICT(provider_account_fingerprint,event_id) DO NOTHING RETURNING * INTO v_row;
  IF FOUND THEN RETURN jsonb_build_object('success',true,'code','event_recorded','event_id',p_event_id); END IF;
  SELECT * INTO v_row FROM public.square_webhook_inbox WHERE provider_account_fingerprint=v_contract->>'provider_account_fingerprint' AND event_id=p_event_id;
  RETURN jsonb_build_object('success',v_row.payload_fingerprint=p_payload_fingerprint,'code',CASE WHEN v_row.payload_fingerprint=p_payload_fingerprint THEN 'event_replay' ELSE 'event_conflict' END,'event_id',p_event_id);
END $$;

CREATE OR REPLACE FUNCTION public.claim_square_webhook_events(p_feature text,p_limit integer DEFAULT 25)
RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_role text:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role',''); v_row public.square_webhook_inbox%ROWTYPE; v_token uuid; v_contract jsonb;
BEGIN
  IF v_role<>'service_role' OR p_feature NOT IN ('loyalty','gift_cards','inventory') OR p_limit NOT BETWEEN 1 AND 100 THEN RETURN; END IF;
  FOR v_row IN SELECT * FROM public.square_webhook_inbox WHERE feature=p_feature AND (status='pending' OR (status='processing' AND lease_expires_at<=clock_timestamp() AND attempt_count<2)) ORDER BY occurred_at,event_id FOR UPDATE SKIP LOCKED LIMIT p_limit LOOP
    v_contract:=public.square_feature_contract(v_row.salon_id,v_row.feature);
    IF v_contract->>'code'<>'ready' OR v_contract->>'provider_account_fingerprint'<>v_row.provider_account_fingerprint THEN UPDATE public.square_webhook_inbox SET status='suppressed',error_code='integration_contract_changed',completed_at=clock_timestamp() WHERE id=v_row.id; CONTINUE; END IF;
    v_token:=gen_random_uuid(); UPDATE public.square_webhook_inbox SET status='processing',claim_token=v_token,attempt_count=attempt_count+1,lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=v_row.id;
    RETURN NEXT jsonb_build_object('inbox_id',v_row.id,'salon_id',v_row.salon_id,'event_id',v_row.event_id,'event_type',v_row.event_type,'occurred_at',v_row.occurred_at,'entity_id',v_row.entity_id,'material',v_row.material,'payload_fingerprint',v_row.payload_fingerprint,'claim_token',v_token);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.complete_square_webhook_event(p_inbox_id uuid,p_claim_token uuid,p_status text,p_result_fingerprint text,p_error_code text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
DECLARE v_role text:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role',''); v_row public.square_webhook_inbox%ROWTYPE;
BEGIN
  IF v_role<>'service_role' THEN RETURN jsonb_build_object('success',false,'code','unauthorized'); END IF;
  IF p_status NOT IN ('processed','failed','unknown') OR p_result_fingerprint!~'^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('success',false,'code','invalid_completion'); END IF;
  SELECT * INTO v_row FROM public.square_webhook_inbox WHERE id=p_inbox_id FOR UPDATE; IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','event_not_found'); END IF;
  IF v_row.status IN ('processed','failed','unknown','suppressed') THEN
    IF v_row.status<>p_status OR v_row.result_fingerprint IS DISTINCT FROM p_result_fingerprint OR v_row.error_code IS DISTINCT FROM p_error_code THEN RETURN jsonb_build_object('success',false,'code','completion_conflict'); END IF;
    RETURN jsonb_build_object('success',true,'code','completion_replay','status',v_row.status);
  END IF;
  IF v_row.status<>'processing' OR v_row.claim_token IS DISTINCT FROM p_claim_token THEN RETURN jsonb_build_object('success',false,'code','claim_mismatch'); END IF;
  UPDATE public.square_webhook_inbox SET status=p_status,result_fingerprint=p_result_fingerprint,error_code=p_error_code,claim_token=NULL,lease_expires_at=NULL,completed_at=clock_timestamp() WHERE id=p_inbox_id RETURNING * INTO v_row;
  IF p_status='processed' THEN INSERT INTO public.square_sync_cursors(salon_id,feature,provider_account_fingerprint,last_event_at,last_event_id) VALUES(v_row.salon_id,v_row.feature,v_row.provider_account_fingerprint,v_row.occurred_at,v_row.event_id) ON CONFLICT(salon_id,feature) DO UPDATE SET last_event_at=GREATEST(square_sync_cursors.last_event_at,excluded.last_event_at),last_event_id=CASE WHEN square_sync_cursors.last_event_at IS NULL OR excluded.last_event_at>=square_sync_cursors.last_event_at THEN excluded.last_event_id ELSE square_sync_cursors.last_event_id END,updated_at=clock_timestamp(); END IF;
  RETURN jsonb_build_object('success',true,'code','event_completed','status',p_status,'event_id',v_row.event_id);
END $$;

REVOKE ALL ON FUNCTION public.square_feature_contract(uuid,text),public.resolve_square_feature_operation_material(uuid,text,jsonb),public.claim_square_feature_operation(uuid,uuid,text,jsonb,text),public.complete_square_feature_operation(uuid,uuid,text,text,text,text,text),public.reconcile_stale_square_feature_operations(text,integer),public.record_square_webhook_event(uuid,text,text,timestamptz,text,jsonb,text),public.claim_square_webhook_events(text,integer),public.complete_square_webhook_event(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.square_feature_contract(uuid,text),public.resolve_square_feature_operation_material(uuid,text,jsonb),public.claim_square_feature_operation(uuid,uuid,text,jsonb,text),public.complete_square_feature_operation(uuid,uuid,text,text,text,text,text),public.reconcile_stale_square_feature_operations(text,integer),public.record_square_webhook_event(uuid,text,text,timestamptz,text,jsonb,text),public.claim_square_webhook_events(text,integer),public.complete_square_webhook_event(uuid,uuid,text,text,text) TO service_role;

COMMENT ON TABLE public.square_feature_operations IS 'Default-off service-role Square Loyalty, Gift Card, and Inventory provider operation ledger; no provider secrets.';
COMMENT ON TABLE public.square_webhook_inbox IS 'Signature-verified Square webhook inbox; event id and payload fingerprint are immutable replay evidence.';
