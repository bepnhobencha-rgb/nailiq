-- MQA-0125: provider-recommended gift-card activation requires the exact
-- Square order line item in addition to the order id. Keep that identifier in
-- the non-sensitive durable operation material and strengthen the receipt
-- chain before any dispatcher can be enabled.

CREATE OR REPLACE FUNCTION public.resolve_square_feature_operation_material(
  p_salon_id uuid,
  p_operation_kind text,
  p_request jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $resolve_square_feature_operation_material$
DECLARE
  v_feature text;
  v_contract jsonb;
  v_material jsonb;
  v_parent public.square_feature_operations%ROWTYPE;
  v_allowed text[];
  v_quantity text;
BEGIN
  v_feature := CASE
    WHEN p_operation_kind LIKE 'loyalty_%' THEN 'loyalty'
    WHEN p_operation_kind LIKE 'gift_card_%' THEN 'gift_cards'
    WHEN p_operation_kind LIKE 'inventory_%' THEN 'inventory'
  END;
  IF v_feature IS NULL OR pg_catalog.jsonb_typeof(p_request) <> 'object' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_request');
  END IF;

  v_contract := public.square_feature_contract(p_salon_id, v_feature);
  IF v_contract ->> 'code' <> 'ready' THEN
    RETURN v_contract;
  END IF;

  v_allowed := ARRAY[
    'source_id', 'secondary_id', 'quantity', 'state', 'from_state', 'to_state',
    'parent_operation_id', 'amount_cents', 'currency', 'order_id',
    'line_item_uid', 'payment_source_token'
  ];
  IF EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_object_keys(p_request) AS k(key)
    WHERE NOT k.key = ANY(v_allowed)
  ) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_request');
  END IF;
  IF nullif(pg_catalog.btrim(p_request ->> 'source_id'), '') IS NULL
     OR pg_catalog.length(p_request ->> 'source_id') > 255
     OR p_request ->> 'source_id' ~ '[[:cntrl:]]' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_source');
  END IF;

  IF p_operation_kind = 'inventory_adjustment' THEN
    v_quantity := p_request ->> 'quantity';
    IF v_quantity IS NULL
       OR v_quantity !~ '^[0-9]{1,12}([.][0-9]{1,5})?$'
       OR v_quantity::numeric <= 0
       OR NOT (
         (p_request ->> 'from_state' = 'NONE' AND p_request ->> 'to_state' = 'IN_STOCK')
         OR (p_request ->> 'from_state' = 'IN_STOCK' AND p_request ->> 'to_state' IN ('SOLD', 'WASTE', 'NONE'))
         OR (p_request ->> 'from_state' = 'UNLINKED_RETURN' AND p_request ->> 'to_state' IN ('IN_STOCK', 'WASTE'))
       ) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_inventory_adjustment');
    END IF;
  END IF;

  IF p_operation_kind IN (
    'gift_card_payment', 'gift_card_activate', 'gift_card_activity',
    'loyalty_reward_redeem', 'loyalty_reward_delete'
  ) THEN
    BEGIN
      SELECT * INTO v_parent
      FROM public.square_feature_operations
      WHERE id = (p_request ->> 'parent_operation_id')::uuid
        AND salon_id = p_salon_id;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_parent');
    END;
    IF NOT FOUND OR v_parent.status <> 'succeeded'
       OR v_parent.provider_account_fingerprint <> v_contract ->> 'provider_account_fingerprint' THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'parent_not_succeeded');
    END IF;
    IF (p_operation_kind = 'gift_card_payment' AND v_parent.operation_kind <> 'gift_card_create')
       OR (p_operation_kind = 'gift_card_activate' AND v_parent.operation_kind <> 'gift_card_payment')
       OR (p_operation_kind = 'gift_card_activity' AND v_parent.operation_kind NOT IN ('gift_card_activate', 'gift_card_activity'))
       OR (p_operation_kind LIKE 'loyalty_reward_%' AND v_parent.operation_kind <> 'loyalty_reward_create') THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'parent_kind_mismatch');
    END IF;
    IF p_operation_kind = 'gift_card_payment' AND (
      (p_request ->> 'amount_cents') !~ '^[1-9][0-9]{0,5}$'
      OR (p_request ->> 'amount_cents')::integer > 200000
      OR p_request ->> 'currency' <> 'CAD'
      OR nullif(pg_catalog.btrim(p_request ->> 'order_id'), '') IS NULL
      OR pg_catalog.length(p_request ->> 'order_id') > 192
      OR nullif(pg_catalog.btrim(p_request ->> 'payment_source_token'), '') IS NULL
      OR pg_catalog.length(p_request ->> 'payment_source_token') > 255
      OR p_request ->> 'source_id' IS DISTINCT FROM v_parent.provider_object_id
    ) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_payment_material');
    END IF;
    IF p_operation_kind = 'gift_card_activate' AND (
      p_request ->> 'amount_cents' IS DISTINCT FROM v_parent.material ->> 'amount_cents'
      OR p_request ->> 'currency' IS DISTINCT FROM v_parent.material ->> 'currency'
      OR p_request ->> 'order_id' IS DISTINCT FROM v_parent.material ->> 'order_id'
      OR p_request ->> 'source_id' IS DISTINCT FROM v_parent.material ->> 'source_id'
      OR nullif(pg_catalog.btrim(p_request ->> 'line_item_uid'), '') IS NULL
      OR pg_catalog.length(p_request ->> 'line_item_uid') > 192
      OR p_request ->> 'line_item_uid' ~ '[[:cntrl:]]'
      OR v_parent.provider_receipt_id IS NULL
    ) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'payment_material_mismatch');
    END IF;
  END IF;

  v_material := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'provider', 'square',
    'api_version', '2026-07-15',
    'feature', v_feature,
    'operation_kind', p_operation_kind,
    'environment', v_contract ->> 'environment',
    'merchant_id', v_contract ->> 'merchant_id',
    'location_id', v_contract ->> 'location_id',
    'provider_account_fingerprint', v_contract ->> 'provider_account_fingerprint',
    'source_id', p_request ->> 'source_id',
    'secondary_id', p_request ->> 'secondary_id',
    'quantity', p_request ->> 'quantity',
    'state', p_request ->> 'state',
    'from_state', p_request ->> 'from_state',
    'to_state', p_request ->> 'to_state',
    'amount_cents', p_request ->> 'amount_cents',
    'currency', p_request ->> 'currency',
    'order_id', p_request ->> 'order_id',
    'line_item_uid', p_request ->> 'line_item_uid',
    'payment_source_fingerprint', CASE
      WHEN p_request ->> 'payment_source_token' IS NULL THEN NULL
      ELSE pg_catalog.encode(
        extensions.digest(
          pg_catalog.convert_to(p_request ->> 'payment_source_token', 'UTF8'),
          'sha256'
        ),
        'hex'
      )
    END,
    'parent_operation_id', CASE WHEN v_parent.id IS NULL THEN NULL ELSE v_parent.id::text END,
    'parent_provider_object_id', v_parent.provider_object_id
  );

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'code', 'resolved',
    'feature', v_feature,
    'provider_material',
      (v_contract - 'success' - 'code' - 'ready' - 'feature_enabled' - 'required_scopes' - 'granted_scopes')
      || pg_catalog.jsonb_build_object(
        'access_token', (
          SELECT access_token FROM public.square_integrations WHERE salon_id = p_salon_id
        ),
        'payment_source_token', p_request ->> 'payment_source_token',
        'order_id', p_request ->> 'order_id',
        'line_item_uid', p_request ->> 'line_item_uid',
        'amount_cents', p_request ->> 'amount_cents',
        'currency', p_request ->> 'currency',
        'autocomplete', true,
        'accept_partial_authorization', false
      ),
    'material', v_material,
    'material_fingerprint', pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(v_material::text, 'UTF8'), 'sha256'),
      'hex'
    )
  );
END
$resolve_square_feature_operation_material$;

REVOKE ALL ON FUNCTION public.resolve_square_feature_operation_material(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_square_feature_operation_material(uuid, text, jsonb)
  TO service_role;

COMMENT ON FUNCTION public.resolve_square_feature_operation_material(uuid, text, jsonb) IS
  'Service-role Square optional-feature material resolver; Gift Card activation requires exact order and line item evidence and stores only the payment source fingerprint.';
