-- MQA-0125: local Square Gift Card reconciliation state. This migration does
-- not call Square, enable Gift Cards, create a NailIQ voucher, or assign local
-- spendable value. Square remains the source of truth for state and balance.

CREATE TABLE public.square_gift_card_mirrors (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  provider_account_fingerprint text NOT NULL
    CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  square_gift_card_id text NOT NULL
    CHECK (length(square_gift_card_id) BETWEEN 1 AND 255 AND square_gift_card_id !~ '[[:cntrl:]]'),
  card_type text CHECK (card_type IS NULL OR card_type IN ('PHYSICAL', 'DIGITAL')),
  gan_source text CHECK (gan_source IS NULL OR gan_source IN ('SQUARE', 'OTHER')),
  state text CHECK (state IS NULL OR state IN ('PENDING', 'ACTIVE', 'BLOCKED', 'DEACTIVATED')),
  balance_cents integer CHECK (balance_cents IS NULL OR balance_cents BETWEEN 0 AND 200000),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  square_created_at timestamptz,
  provider_updated_at timestamptz,
  last_event_at timestamptz,
  create_operation_id uuid REFERENCES public.square_feature_operations(id) ON DELETE RESTRICT,
  payment_operation_id uuid REFERENCES public.square_feature_operations(id) ON DELETE RESTRICT,
  activation_operation_id uuid UNIQUE REFERENCES public.square_feature_operations(id) ON DELETE RESTRICT,
  square_activation_activity_id text
    CHECK (square_activation_activity_id IS NULL OR (
      length(square_activation_activity_id) BETWEEN 1 AND 255
      AND square_activation_activity_id !~ '[[:cntrl:]]'
    )),
  issuance_amount_cents integer CHECK (issuance_amount_cents IS NULL OR issuance_amount_cents BETWEEN 1 AND 200000),
  issuance_currency text CHECK (issuance_currency IS NULL OR issuance_currency ~ '^[A-Z]{3}$'),
  receipt_bound_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (salon_id, provider_account_fingerprint, square_gift_card_id),
  UNIQUE (salon_id, id),
  CONSTRAINT square_gift_card_receipt_chain_complete CHECK (
    (create_operation_id IS NULL AND payment_operation_id IS NULL
      AND activation_operation_id IS NULL AND square_activation_activity_id IS NULL
      AND issuance_amount_cents IS NULL AND issuance_currency IS NULL
      AND receipt_bound_at IS NULL)
    OR
    (create_operation_id IS NOT NULL AND payment_operation_id IS NOT NULL
      AND activation_operation_id IS NOT NULL AND square_activation_activity_id IS NOT NULL
      AND issuance_amount_cents IS NOT NULL AND issuance_currency IS NOT NULL
      AND receipt_bound_at IS NOT NULL)
  )
);

CREATE INDEX square_gift_card_provider_idx
  ON public.square_gift_card_mirrors (provider_account_fingerprint, square_gift_card_id);
CREATE INDEX square_gift_card_create_operation_idx
  ON public.square_gift_card_mirrors (create_operation_id)
  WHERE create_operation_id IS NOT NULL;
CREATE INDEX square_gift_card_payment_operation_idx
  ON public.square_gift_card_mirrors (payment_operation_id)
  WHERE payment_operation_id IS NOT NULL;

CREATE TABLE public.square_gift_card_activity_mirrors (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL,
  gift_card_mirror_id uuid NOT NULL,
  inbox_id uuid NOT NULL UNIQUE REFERENCES public.square_webhook_inbox(id) ON DELETE RESTRICT,
  provider_account_fingerprint text NOT NULL
    CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  square_activity_id text NOT NULL
    CHECK (length(square_activity_id) BETWEEN 1 AND 255 AND square_activity_id !~ '[[:cntrl:]]'),
  webhook_event_id text NOT NULL
    CHECK (length(webhook_event_id) BETWEEN 1 AND 255 AND webhook_event_id !~ '[[:cntrl:]]'),
  activity_type text NOT NULL CHECK (activity_type IN (
    'ACTIVATE', 'LOAD', 'REDEEM', 'CLEAR_BALANCE', 'DEACTIVATE',
    'ADJUST_INCREMENT', 'ADJUST_DECREMENT', 'REFUND',
    'UNLINKED_ACTIVITY_REFUND', 'IMPORT', 'BLOCK', 'UNBLOCK',
    'IMPORT_REVERSAL', 'TRANSFER_BALANCE_FROM', 'TRANSFER_BALANCE_TO'
  )),
  activity_status text CHECK (activity_status IS NULL OR activity_status IN ('PENDING', 'COMPLETED', 'CANCELED')),
  value_direction text NOT NULL CHECK (value_direction IN ('increase', 'decrease', 'state_only')),
  amount_cents integer CHECK (amount_cents IS NULL OR amount_cents BETWEEN 1 AND 200000),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  provider_balance_after_cents integer NOT NULL CHECK (provider_balance_after_cents BETWEEN 0 AND 200000),
  provider_balance_currency text NOT NULL CHECK (provider_balance_currency ~ '^[A-Z]{3}$'),
  square_location_id text NOT NULL
    CHECK (length(square_location_id) BETWEEN 1 AND 255 AND square_location_id !~ '[[:cntrl:]]'),
  square_order_id text CHECK (square_order_id IS NULL OR (length(square_order_id) BETWEEN 1 AND 255 AND square_order_id !~ '[[:cntrl:]]')),
  square_payment_id text CHECK (square_payment_id IS NULL OR (length(square_payment_id) BETWEEN 1 AND 255 AND square_payment_id !~ '[[:cntrl:]]')),
  square_redeem_activity_id text CHECK (square_redeem_activity_id IS NULL OR (length(square_redeem_activity_id) BETWEEN 1 AND 255 AND square_redeem_activity_id !~ '[[:cntrl:]]')),
  reference_id text CHECK (reference_id IS NULL OR (length(reference_id) BETWEEN 1 AND 255 AND reference_id !~ '[[:cntrl:]]')),
  reason text CHECK (reason IS NULL OR (length(reason) BETWEEN 1 AND 255 AND reason !~ '[[:cntrl:]]')),
  occurred_at timestamptz NOT NULL,
  webhook_occurred_at timestamptz NOT NULL,
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  UNIQUE (provider_account_fingerprint, webhook_event_id),
  FOREIGN KEY (salon_id, gift_card_mirror_id)
    REFERENCES public.square_gift_card_mirrors(salon_id, id) ON DELETE CASCADE,
  CONSTRAINT square_gift_card_activity_amount_shape CHECK (
    (activity_type IN (
      'ACTIVATE', 'LOAD', 'REDEEM', 'ADJUST_INCREMENT', 'ADJUST_DECREMENT',
      'REFUND', 'UNLINKED_ACTIVITY_REFUND'
    ) AND amount_cents IS NOT NULL AND currency IS NOT NULL)
    OR
    (activity_type NOT IN (
      'ACTIVATE', 'LOAD', 'REDEEM', 'ADJUST_INCREMENT', 'ADJUST_DECREMENT',
      'REFUND', 'UNLINKED_ACTIVITY_REFUND'
    ))
  )
);

CREATE INDEX square_gift_card_activity_card_history_idx
  ON public.square_gift_card_activity_mirrors (gift_card_mirror_id, webhook_occurred_at DESC);
CREATE INDEX square_gift_card_activity_card_fk_idx
  ON public.square_gift_card_activity_mirrors (salon_id, gift_card_mirror_id);
CREATE INDEX square_gift_card_activity_provider_id_idx
  ON public.square_gift_card_activity_mirrors (
    provider_account_fingerprint, square_activity_id, webhook_occurred_at DESC
  );
CREATE INDEX square_gift_card_activity_salon_history_idx
  ON public.square_gift_card_activity_mirrors (salon_id, webhook_occurred_at DESC);

ALTER TABLE public.square_gift_card_mirrors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.square_gift_card_mirrors FORCE ROW LEVEL SECURITY;
ALTER TABLE public.square_gift_card_activity_mirrors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.square_gift_card_activity_mirrors FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.square_gift_card_mirrors,
  public.square_gift_card_activity_mirrors
FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.square_gift_card_mirrors,
  public.square_gift_card_activity_mirrors
TO service_role;

CREATE OR REPLACE FUNCTION public.reject_square_gift_card_activity_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $reject_square_gift_card_activity_mutation$
BEGIN
  IF pg_catalog.pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501',
    MESSAGE = 'Square gift card activity mirrors are immutable';
END;
$reject_square_gift_card_activity_mutation$;

REVOKE ALL ON FUNCTION public.reject_square_gift_card_activity_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER reject_square_gift_card_activity_mutation
  BEFORE UPDATE OR DELETE ON public.square_gift_card_activity_mirrors
  FOR EACH ROW EXECUTE FUNCTION public.reject_square_gift_card_activity_mutation();

CREATE OR REPLACE FUNCTION public.bind_square_gift_card_issuance(
  p_salon_id uuid,
  p_activation_operation_id uuid,
  p_square_gift_card_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $bind_square_gift_card_issuance$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_activate public.square_feature_operations%ROWTYPE;
  v_payment public.square_feature_operations%ROWTYPE;
  v_create public.square_feature_operations%ROWTYPE;
  v_card public.square_gift_card_mirrors%ROWTYPE;
  v_amount integer;
  v_currency text;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_activation_operation_id IS NULL
     OR p_square_gift_card_id IS NULL
     OR pg_catalog.length(p_square_gift_card_id) NOT BETWEEN 1 AND 255
     OR p_square_gift_card_id ~ '[[:cntrl:]]' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_issuance_binding');
  END IF;

  SELECT o.* INTO v_activate
  FROM public.square_feature_operations AS o
  WHERE o.id = p_activation_operation_id
    AND o.salon_id = p_salon_id
    AND o.feature = 'gift_cards'
    AND o.operation_kind = 'gift_card_activate'
    AND o.status = 'succeeded'
    AND o.provider_object_id IS NOT NULL
    AND o.provider_receipt_id IS NOT NULL
    AND o.material ->> 'source_id' = p_square_gift_card_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'activation_receipt_required');
  END IF;

  SELECT o.* INTO v_payment
  FROM public.square_feature_operations AS o
  WHERE o.id = v_activate.parent_operation_id
    AND o.salon_id = p_salon_id
    AND o.feature = 'gift_cards'
    AND o.operation_kind = 'gift_card_payment'
    AND o.status = 'succeeded'
    AND o.provider_object_id IS NOT NULL
    AND o.provider_receipt_id IS NOT NULL;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'payment_receipt_required');
  END IF;

  SELECT o.* INTO v_create
  FROM public.square_feature_operations AS o
  WHERE o.id = v_payment.parent_operation_id
    AND o.salon_id = p_salon_id
    AND o.feature = 'gift_cards'
    AND o.operation_kind = 'gift_card_create'
    AND o.status = 'succeeded'
    AND o.provider_object_id = p_square_gift_card_id
    AND o.provider_receipt_id IS NOT NULL;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'create_receipt_required');
  END IF;

  BEGIN
    v_amount := (v_payment.material ->> 'amount_cents')::integer;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_receipt_material');
  END;
  v_currency := v_payment.material ->> 'currency';
  IF v_amount NOT BETWEEN 1 AND 200000 OR v_currency <> 'CAD'
     OR v_payment.material ->> 'source_id' IS DISTINCT FROM p_square_gift_card_id
     OR v_activate.material ->> 'amount_cents' IS DISTINCT FROM v_payment.material ->> 'amount_cents'
     OR v_activate.material ->> 'currency' IS DISTINCT FROM v_currency
     OR v_activate.material ->> 'order_id' IS DISTINCT FROM v_payment.material ->> 'order_id'
     OR nullif(trim(v_activate.material ->> 'line_item_uid'), '') IS NULL
     OR v_activate.provider_account_fingerprint <> v_payment.provider_account_fingerprint
     OR v_payment.provider_account_fingerprint <> v_create.provider_account_fingerprint THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'receipt_chain_mismatch');
  END IF;

  SELECT c.* INTO v_card
  FROM public.square_gift_card_mirrors AS c
  WHERE c.salon_id = p_salon_id
    AND c.provider_account_fingerprint = v_activate.provider_account_fingerprint
    AND c.square_gift_card_id = p_square_gift_card_id
  FOR UPDATE;
  IF FOUND AND v_card.activation_operation_id IS NOT NULL
     AND v_card.activation_operation_id <> v_activate.id THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'issuance_binding_conflict');
  END IF;

  INSERT INTO public.square_gift_card_mirrors (
    salon_id, provider_account_fingerprint, square_gift_card_id,
    create_operation_id, payment_operation_id, activation_operation_id,
    square_activation_activity_id, issuance_amount_cents,
    issuance_currency, receipt_bound_at
  ) VALUES (
    p_salon_id, v_activate.provider_account_fingerprint, p_square_gift_card_id,
    v_create.id, v_payment.id, v_activate.id, v_activate.provider_object_id,
    v_amount, v_currency, transaction_timestamp()
  )
  ON CONFLICT (salon_id, provider_account_fingerprint, square_gift_card_id)
  DO UPDATE SET
    create_operation_id = excluded.create_operation_id,
    payment_operation_id = excluded.payment_operation_id,
    activation_operation_id = excluded.activation_operation_id,
    square_activation_activity_id = excluded.square_activation_activity_id,
    issuance_amount_cents = excluded.issuance_amount_cents,
    issuance_currency = excluded.issuance_currency,
    receipt_bound_at = coalesce(
      public.square_gift_card_mirrors.receipt_bound_at,
      excluded.receipt_bound_at
    ),
    updated_at = transaction_timestamp()
  RETURNING * INTO v_card;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'code', 'issuance_receipts_bound',
    'gift_card_mirror_id', v_card.id,
    'square_gift_card_id', v_card.square_gift_card_id,
    'issuance_amount_cents', v_card.issuance_amount_cents,
    'issuance_currency', v_card.issuance_currency
  );
END;
$bind_square_gift_card_issuance$;

REVOKE ALL ON FUNCTION public.bind_square_gift_card_issuance(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_square_gift_card_issuance(uuid, uuid, text)
  TO service_role;

CREATE OR REPLACE FUNCTION public.apply_square_gift_card_webhook_event(
  p_inbox_id uuid,
  p_claim_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $apply_square_gift_card_webhook_event$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_inbox public.square_webhook_inbox%ROWTYPE;
  v_contract jsonb;
  v_entity jsonb;
  v_card public.square_gift_card_mirrors%ROWTYPE;
  v_activity public.square_gift_card_activity_mirrors%ROWTYPE;
  v_card_id text;
  v_type text;
  v_state text;
  v_gan_source text;
  v_location_id text;
  v_status text;
  v_currency text;
  v_balance_currency text;
  v_amount integer;
  v_balance integer;
  v_card_created_at timestamptz;
  v_activity_occurred_at timestamptz;
  v_direction text;
  v_result_fingerprint text;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_inbox_id IS NULL OR p_claim_token IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_claim');
  END IF;

  SELECT i.* INTO v_inbox
  FROM public.square_webhook_inbox AS i
  WHERE i.id = p_inbox_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'event_not_found');
  END IF;
  IF v_inbox.feature <> 'gift_cards' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'feature_mismatch');
  END IF;
  IF v_inbox.status = 'processed' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', true, 'code', 'application_replay', 'event_id', v_inbox.event_id
    );
  END IF;
  IF v_inbox.status <> 'processing' OR v_inbox.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'claim_mismatch');
  END IF;

  v_contract := public.square_feature_contract(v_inbox.salon_id, 'gift_cards');
  IF v_contract ->> 'code' <> 'ready'
     OR v_contract ->> 'provider_account_fingerprint'
       <> v_inbox.provider_account_fingerprint THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'integration_contract_changed');
  END IF;
  v_entity := v_inbox.material -> 'entity';
  IF pg_catalog.jsonb_typeof(v_entity) <> 'object'
     OR v_entity ->> 'id' IS DISTINCT FROM v_inbox.entity_id THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_gift_card_material');
  END IF;

  IF v_inbox.event_type IN (
    'gift_card.created', 'gift_card.updated',
    'gift_card.customer_linked', 'gift_card.customer_unlinked'
  ) THEN
    v_card_id := v_entity ->> 'id';
    v_type := v_entity ->> 'type';
    v_gan_source := v_entity ->> 'gan_source';
    v_state := v_entity ->> 'state';
    v_currency := v_entity #>> '{balance_money,currency}';
    BEGIN
      v_balance := (v_entity #>> '{balance_money,amount}')::integer;
      v_card_created_at := (v_entity ->> 'created_at')::timestamptz;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range
      OR datetime_field_overflow OR invalid_datetime_format THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_gift_card_material');
    END;
    IF v_type NOT IN ('PHYSICAL', 'DIGITAL')
       OR v_gan_source NOT IN ('SQUARE', 'OTHER')
       OR v_state NOT IN ('PENDING', 'ACTIVE', 'BLOCKED', 'DEACTIVATED')
       OR v_balance NOT BETWEEN 0 AND 200000
       OR v_currency <> 'CAD'
       OR v_card_created_at IS NULL THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_gift_card_material');
    END IF;

    INSERT INTO public.square_gift_card_mirrors (
      salon_id, provider_account_fingerprint, square_gift_card_id,
      card_type, gan_source, state, balance_cents, currency,
      square_created_at, provider_updated_at, last_event_at
    ) VALUES (
      v_inbox.salon_id, v_inbox.provider_account_fingerprint, v_card_id,
      v_type, v_gan_source, v_state, v_balance, v_currency,
      v_card_created_at, v_inbox.occurred_at, v_inbox.occurred_at
    )
    ON CONFLICT (salon_id, provider_account_fingerprint, square_gift_card_id)
    DO UPDATE SET
      card_type = CASE
        WHEN public.square_gift_card_mirrors.card_type IS NULL
          OR public.square_gift_card_mirrors.provider_updated_at IS NULL
          OR excluded.provider_updated_at >= public.square_gift_card_mirrors.provider_updated_at
        THEN excluded.card_type ELSE public.square_gift_card_mirrors.card_type END,
      gan_source = CASE
        WHEN public.square_gift_card_mirrors.gan_source IS NULL
          OR public.square_gift_card_mirrors.provider_updated_at IS NULL
          OR excluded.provider_updated_at >= public.square_gift_card_mirrors.provider_updated_at
        THEN excluded.gan_source ELSE public.square_gift_card_mirrors.gan_source END,
      state = CASE
        WHEN public.square_gift_card_mirrors.state IS NULL
          OR public.square_gift_card_mirrors.provider_updated_at IS NULL
          OR excluded.provider_updated_at >= public.square_gift_card_mirrors.provider_updated_at
        THEN excluded.state ELSE public.square_gift_card_mirrors.state END,
      balance_cents = CASE
        WHEN public.square_gift_card_mirrors.provider_updated_at IS NULL
          OR excluded.provider_updated_at >= public.square_gift_card_mirrors.provider_updated_at
        THEN excluded.balance_cents ELSE public.square_gift_card_mirrors.balance_cents END,
      currency = CASE
        WHEN public.square_gift_card_mirrors.provider_updated_at IS NULL
          OR excluded.provider_updated_at >= public.square_gift_card_mirrors.provider_updated_at
        THEN excluded.currency ELSE public.square_gift_card_mirrors.currency END,
      square_created_at = coalesce(
        public.square_gift_card_mirrors.square_created_at, excluded.square_created_at
      ),
      provider_updated_at = greatest(
        public.square_gift_card_mirrors.provider_updated_at, excluded.provider_updated_at
      ),
      last_event_at = greatest(
        public.square_gift_card_mirrors.last_event_at, excluded.last_event_at
      ),
      updated_at = transaction_timestamp()
    RETURNING * INTO v_card;
  ELSIF v_inbox.event_type IN (
    'gift_card.activity.created', 'gift_card.activity.updated'
  ) THEN
    v_card_id := v_entity ->> 'gift_card_id';
    v_type := v_entity ->> 'type';
    v_location_id := v_entity ->> 'location_id';
    v_status := nullif(v_entity ->> 'status', '');
    v_currency := nullif(v_entity #>> '{amount_money,currency}', '');
    v_balance_currency := v_entity #>> '{gift_card_balance_money,currency}';
    BEGIN
      v_amount := CASE WHEN v_entity -> 'amount_money' IS NULL THEN NULL
        ELSE (v_entity #>> '{amount_money,amount}')::integer END;
      v_balance := (v_entity #>> '{gift_card_balance_money,amount}')::integer;
      v_activity_occurred_at := (v_entity ->> 'created_at')::timestamptz;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range
      OR datetime_field_overflow OR invalid_datetime_format THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_gift_card_material');
    END;
    v_direction := CASE
      WHEN v_type IN (
        'ACTIVATE', 'LOAD', 'ADJUST_INCREMENT', 'REFUND',
        'UNLINKED_ACTIVITY_REFUND', 'IMPORT', 'TRANSFER_BALANCE_TO'
      ) THEN 'increase'
      WHEN v_type IN (
        'REDEEM', 'CLEAR_BALANCE', 'ADJUST_DECREMENT',
        'IMPORT_REVERSAL', 'TRANSFER_BALANCE_FROM'
      ) THEN 'decrease'
      ELSE 'state_only'
    END;
    IF v_type NOT IN (
         'ACTIVATE', 'LOAD', 'REDEEM', 'CLEAR_BALANCE', 'DEACTIVATE',
         'ADJUST_INCREMENT', 'ADJUST_DECREMENT', 'REFUND',
         'UNLINKED_ACTIVITY_REFUND', 'IMPORT', 'BLOCK', 'UNBLOCK',
         'IMPORT_REVERSAL', 'TRANSFER_BALANCE_FROM', 'TRANSFER_BALANCE_TO'
       ) OR v_card_id IS NULL OR pg_catalog.length(v_card_id) NOT BETWEEN 1 AND 255
       OR v_card_id ~ '[[:cntrl:]]'
       OR v_location_id IS DISTINCT FROM v_contract ->> 'location_id'
       OR v_activity_occurred_at IS NULL
       OR v_balance NOT BETWEEN 0 AND 200000 OR v_balance_currency <> 'CAD'
       OR (v_amount IS NOT NULL AND (v_amount NOT BETWEEN 1 AND 200000 OR v_currency <> 'CAD'))
       OR (v_type IN (
          'ACTIVATE', 'LOAD', 'REDEEM', 'ADJUST_INCREMENT',
          'ADJUST_DECREMENT', 'REFUND', 'UNLINKED_ACTIVITY_REFUND'
        ) AND v_amount IS NULL)
       OR (v_status IS NOT NULL AND v_status NOT IN ('PENDING', 'COMPLETED', 'CANCELED')) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_gift_card_material');
    END IF;

    INSERT INTO public.square_gift_card_mirrors (
      salon_id, provider_account_fingerprint, square_gift_card_id,
      balance_cents, currency, provider_updated_at, last_event_at
    ) VALUES (
      v_inbox.salon_id, v_inbox.provider_account_fingerprint, v_card_id,
      v_balance, v_balance_currency, v_inbox.occurred_at, v_inbox.occurred_at
    )
    ON CONFLICT (salon_id, provider_account_fingerprint, square_gift_card_id)
    DO UPDATE SET
      balance_cents = CASE
        WHEN public.square_gift_card_mirrors.provider_updated_at IS NULL
          OR excluded.provider_updated_at >= public.square_gift_card_mirrors.provider_updated_at
        THEN excluded.balance_cents ELSE public.square_gift_card_mirrors.balance_cents END,
      currency = CASE
        WHEN public.square_gift_card_mirrors.provider_updated_at IS NULL
          OR excluded.provider_updated_at >= public.square_gift_card_mirrors.provider_updated_at
        THEN excluded.currency ELSE public.square_gift_card_mirrors.currency END,
      provider_updated_at = greatest(
        public.square_gift_card_mirrors.provider_updated_at, excluded.provider_updated_at
      ),
      last_event_at = greatest(
        public.square_gift_card_mirrors.last_event_at, excluded.last_event_at
      ),
      updated_at = transaction_timestamp()
    RETURNING * INTO v_card;

    INSERT INTO public.square_gift_card_activity_mirrors (
      salon_id, gift_card_mirror_id, inbox_id,
      provider_account_fingerprint, square_activity_id, webhook_event_id,
      activity_type, activity_status, value_direction,
      amount_cents, currency, provider_balance_after_cents,
      provider_balance_currency, square_location_id, square_order_id,
      square_payment_id, square_redeem_activity_id, reference_id, reason,
      occurred_at, webhook_occurred_at, payload_fingerprint
    ) VALUES (
      v_inbox.salon_id, v_card.id, v_inbox.id,
      v_inbox.provider_account_fingerprint, v_inbox.entity_id, v_inbox.event_id,
      v_type, v_status, v_direction, v_amount, v_currency,
      v_balance, v_balance_currency, v_location_id,
      nullif(v_entity ->> 'order_id', ''),
      nullif(v_entity ->> 'payment_id', ''),
      nullif(v_entity ->> 'redeem_activity_id', ''),
      nullif(v_entity ->> 'reference_id', ''),
      nullif(v_entity ->> 'reason', ''),
      v_activity_occurred_at, v_inbox.occurred_at, v_inbox.payload_fingerprint
    )
    ON CONFLICT (provider_account_fingerprint, webhook_event_id) DO NOTHING
    RETURNING * INTO v_activity;
    IF NOT FOUND THEN
      SELECT a.* INTO v_activity
      FROM public.square_gift_card_activity_mirrors AS a
      WHERE a.provider_account_fingerprint = v_inbox.provider_account_fingerprint
        AND a.webhook_event_id = v_inbox.event_id;
      IF v_activity.payload_fingerprint <> v_inbox.payload_fingerprint
         OR v_activity.inbox_id <> v_inbox.id THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'gift_card_activity_conflict');
      END IF;
    END IF;
  ELSE
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unsupported_gift_card_event');
  END IF;

  v_result_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'inbox_id', v_inbox.id,
          'event_id', v_inbox.event_id,
          'payload_fingerprint', v_inbox.payload_fingerprint,
          'gift_card_mirror_id', v_card.id,
          'activity_mirror_id', v_activity.id
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  UPDATE public.square_webhook_inbox
  SET status = 'processed', result_fingerprint = v_result_fingerprint,
      error_code = NULL, claim_token = NULL, lease_expires_at = NULL,
      completed_at = clock_timestamp()
  WHERE id = v_inbox.id;
  INSERT INTO public.square_sync_cursors (
    salon_id, feature, provider_account_fingerprint,
    last_event_at, last_event_id
  ) VALUES (
    v_inbox.salon_id, 'gift_cards', v_inbox.provider_account_fingerprint,
    v_inbox.occurred_at, v_inbox.event_id
  )
  ON CONFLICT (salon_id, feature) DO UPDATE SET
    last_event_at = greatest(
      public.square_sync_cursors.last_event_at, excluded.last_event_at
    ),
    last_event_id = CASE
      WHEN public.square_sync_cursors.last_event_at IS NULL
        OR excluded.last_event_at >= public.square_sync_cursors.last_event_at
      THEN excluded.last_event_id ELSE public.square_sync_cursors.last_event_id
    END,
    updated_at = clock_timestamp();

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'code', 'gift_card_event_applied',
    'event_id', v_inbox.event_id,
    'gift_card_mirror_id', v_card.id,
    'activity_mirror_id', v_activity.id,
    'result_fingerprint', v_result_fingerprint
  );
END;
$apply_square_gift_card_webhook_event$;

REVOKE ALL ON FUNCTION public.apply_square_gift_card_webhook_event(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_square_gift_card_webhook_event(uuid, uuid)
  TO service_role;

COMMENT ON TABLE public.square_gift_card_mirrors IS
  'GAN-free Square Gift Card state and balance mirror. Square is the source of truth; no NailIQ voucher is minted.';
COMMENT ON TABLE public.square_gift_card_activity_mirrors IS
  'Immutable append-only Square Gift Card activity revisions, including partial redeem and refund evidence.';
