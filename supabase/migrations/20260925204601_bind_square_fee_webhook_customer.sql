-- A signed payment must belong to the exact customer approved for this fee.
-- This receives only Square's opaque customer ID; no customer/card PII is
-- persisted or returned. Keep the legacy entry point, but fail closed for
-- saved-card fees when an old runtime cannot supply the binding evidence.
BEGIN;

DO $bind$
DECLARE
  definition text := pg_get_functiondef('public.record_square_payment_webhook_event(uuid,text,text,timestamp with time zone,text,text,text,text,integer,text,timestamp with time zone,text,text,text,text)'::regprocedure);
  anchor text;
  replacement text;
BEGIN
  anchor := 'CREATE OR REPLACE FUNCTION public.record_square_payment_webhook_event(';
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'fee webhook customer prerequisite drift: function header';
  END IF;
  definition := replace(definition, anchor,
    'CREATE OR REPLACE FUNCTION public.record_square_payment_webhook_event_bound(');
  anchor := 'p_environment text)';
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'fee webhook customer prerequisite drift: arguments';
  END IF;
  definition := replace(definition, anchor, 'p_environment text, p_customer_id text)');

  anchor := $old$     OR p_environment NOT IN ('sandbox', 'production') THEN$old$;
  replacement := $new$     OR (p_customer_id IS NOT NULL AND (
       length(p_customer_id) NOT BETWEEN 1 AND 255 OR p_customer_id !~ '^[[:graph:]]+$'
     ))
     OR p_environment NOT IN ('sandbox', 'production') THEN$new$;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'fee webhook customer prerequisite drift: input validation';
  END IF;
  definition := replace(definition, anchor, replacement);

  -- Replay is still a no-op, but it must not let an old caller or a changed
  -- customer claim receive an accepted result without the required binding.
  anchor := $old$  IF v_inbox.applied_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true, 'code', 'event_replay', 'event_id', p_event_id,
      'result_code', v_inbox.result_code
    );
  END IF;
$old$;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'fee webhook customer prerequisite drift: replay guard';
  END IF;
  definition := replace(definition, anchor, '');

  anchor := $old$  SELECT i.* INTO v_latest FROM public.square_payment_webhook_inbox i$old$;
  replacement := $new$  -- Match the originally approved customer, never current mutable booking
  -- metadata. Missing customer evidence cannot confirm or reject a fee.
  IF v_operation.operation_kind IN ('noshow_charge', 'late_cancel_charge') AND (
    nullif(p_customer_id, '') IS NULL
    OR nullif(v_operation.provider_material->>'customer_id', '') IS NULL
    OR v_operation.provider_material->>'customer_id' IS DISTINCT FROM p_customer_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'provider_binding_mismatch');
  END IF;

  IF v_inbox.applied_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true, 'code', 'event_replay', 'event_id', p_event_id,
      'result_code', v_inbox.result_code
    );
  END IF;

  SELECT i.* INTO v_latest FROM public.square_payment_webhook_inbox i$new$;
  IF (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 THEN
    RAISE EXCEPTION 'fee webhook customer prerequisite drift: binding guard';
  END IF;
  definition := replace(definition, anchor, replacement);
  EXECUTE definition;
END
$bind$;

CREATE OR REPLACE FUNCTION public.record_square_payment_webhook_event(
  p_salon_id uuid, p_event_id text, p_event_type text, p_occurred_at timestamptz,
  p_payload_fingerprint text, p_provider_payment_id text, p_location_id text,
  p_provider_status text, p_amount_cents integer, p_currency text,
  p_payment_updated_at timestamptz, p_reference_id text, p_merchant_id text,
  p_application_id text, p_environment text
) RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path TO ''
AS $legacy$
  SELECT public.record_square_payment_webhook_event_bound(
    p_salon_id, p_event_id, p_event_type, p_occurred_at, p_payload_fingerprint,
    p_provider_payment_id, p_location_id, p_provider_status, p_amount_cents,
    p_currency, p_payment_updated_at, p_reference_id, p_merchant_id,
    p_application_id, p_environment, NULL::text
  );
$legacy$;

REVOKE ALL ON FUNCTION public.record_square_payment_webhook_event_bound(
  uuid,text,text,timestamptz,text,text,text,text,integer,text,timestamptz,text,text,text,text,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_square_payment_webhook_event_bound(
  uuid,text,text,timestamptz,text,text,text,text,integer,text,timestamptz,text,text,text,text,text
) TO service_role;
REVOKE ALL ON FUNCTION public.record_square_payment_webhook_event(
  uuid,text,text,timestamptz,text,text,text,text,integer,text,timestamptz,text,text,text,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_square_payment_webhook_event(
  uuid,text,text,timestamptz,text,text,text,text,integer,text,timestamptz,text,text,text,text
) TO service_role;

COMMENT ON FUNCTION public.record_square_payment_webhook_event_bound(
  uuid,text,text,timestamptz,text,text,text,text,integer,text,timestamptz,text,text,text,text,text
) IS 'Signed Square payment truth with exact immutable customer binding for saved-card fee operations. Opaque customer ID is compared only, not persisted or returned.';

COMMIT;
