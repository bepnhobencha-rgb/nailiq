-- Durable reference versioning for new approved fees only. No historical
-- material or provider request is rewritten. Claims return the same marker
-- they fingerprint and persist, so response-loss replay keeps the exact body.
-- Exact source anchors fail closed if a prerequisite function has drifted.
BEGIN;
DO $patch0$
DECLARE
  definition text := pg_get_functiondef('public.resolve_booking_payment_operation_material(uuid,uuid,text,integer,boolean,uuid)'::regprocedure);
  original text := $old0$  v_fingerprint := encode(
    extensions.digest(convert_to(v_fingerprint_material::text,'UTF8'),'sha256'),'hex'
  );$old0$;
  replacement text := $new0$  IF p_operation_kind = 'noshow_charge' THEN
    v_fingerprint_material := v_fingerprint_material || jsonb_build_object(
      'provider_request_reference', p_booking_id::text
    );
  END IF;
  v_fingerprint := encode(
    extensions.digest(convert_to(v_fingerprint_material::text,'UTF8'),'sha256'),'hex'
  );$new0$;
BEGIN
  IF (length(definition) - length(replace(definition, original, ''))) / length(original) <> 1 THEN
    RAISE EXCEPTION 'fee request reference prerequisite drift: patch 0';
  END IF;
  EXECUTE replace(definition, original, replacement);
END
$patch0$;

DO $patch1$
DECLARE
  definition text := pg_get_functiondef('public.resolve_booking_payment_operation_material(uuid,uuid,text,integer,boolean,uuid)'::regprocedure);
  original text := $old1$    'material_fingerprint',v_fingerprint
  );$old1$;
  replacement text := $new1$    'material_fingerprint',v_fingerprint
  ) || CASE WHEN p_operation_kind = 'noshow_charge' THEN jsonb_build_object(
    'provider_request_reference', p_booking_id::text
  ) ELSE '{}'::jsonb END;$new1$;
BEGIN
  IF (length(definition) - length(replace(definition, original, ''))) / length(original) <> 1 THEN
    RAISE EXCEPTION 'fee request reference prerequisite drift: patch 1';
  END IF;
  EXECUTE replace(definition, original, replacement);
END
$patch1$;

DO $patch2$
DECLARE
  definition text := pg_get_functiondef('public.claim_approved_cancellation_fee_payment(text,uuid,uuid,uuid,text)'::regprocedure);
  original text := $old2$    'operation_kind', 'late_cancel_charge',
    'provider', v_context->>'provider',$old2$;
  replacement text := $new2$    'operation_kind', 'late_cancel_charge',
    'provider_request_reference', v_booking_id::text,
    'provider', v_context->>'provider',$new2$;
BEGIN
  IF (length(definition) - length(replace(definition, original, ''))) / length(original) <> 1 THEN
    RAISE EXCEPTION 'fee request reference prerequisite drift: patch 2';
  END IF;
  EXECUTE replace(definition, original, replacement);
END
$patch2$;

DO $patch3$
DECLARE
  definition text := pg_get_functiondef('public.record_square_payment_webhook_event(uuid,text,text,timestamp with time zone,text,text,text,text,integer,text,timestamp with time zone,text,text,text,text)'::regprocedure);
  original text := $old3$  IF v_operation.id IS NULL THEN
    UPDATE public.square_payment_webhook_inbox$old3$;
  replacement text := $new3$  -- New fee operations retain the exact <=40-character request reference in
  -- immutable material. Historical booking:UUID requests keep their old path.
  -- Never guess among multiple operations or broaden matching by amount alone.
  IF v_operation.id IS NULL AND p_reference_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    v_booking_id := p_reference_id::uuid;
    SELECT count(*), (array_agg(o.id ORDER BY o.created_at, o.id))[1]
      INTO v_candidate_count, v_candidate_id
      FROM public.booking_payment_operations o
     WHERE o.salon_id = p_salon_id AND o.booking_id = v_booking_id
       AND o.provider = 'square'
       AND o.provider_account_fingerprint = v_account_fingerprint
       AND o.material_json->>'provider_request_reference' = p_reference_id
       AND o.operation_kind IN ('noshow_charge', 'late_cancel_charge')
       AND o.amount_cents = p_amount_cents AND o.currency = p_currency
       AND o.status IN ('sending', 'pending_provider', 'reconciling', 'unknown', 'succeeded');
    IF v_candidate_count = 1 THEN
      SELECT o.* INTO v_operation FROM public.booking_payment_operations o
       WHERE o.id = v_candidate_id FOR UPDATE;
    END IF;
  END IF;
  IF v_operation.id IS NULL THEN
    UPDATE public.square_payment_webhook_inbox$new3$;
BEGIN
  IF (length(definition) - length(replace(definition, original, ''))) / length(original) <> 1 THEN
    RAISE EXCEPTION 'fee request reference prerequisite drift: patch 3';
  END IF;
  EXECUTE replace(definition, original, replacement);
END
$patch3$;

-- Webhook completion must project the same booking truth as synchronous
-- completion; otherwise a paid cancellation remains shown as uncollected.
DO $patch4$
DECLARE
  definition text := pg_get_functiondef('public.record_square_payment_webhook_event(uuid,text,text,timestamp with time zone,text,text,text,text,integer,text,timestamp with time zone,text,text,text,text)'::regprocedure);
  original text := $old4$         AND r.state = 'approved_charge';
    END IF;
    v_result_code := 'payment_applied';$old4$;
  replacement text := $new4$         AND r.state = 'approved_charge';
    ELSIF v_operation.operation_kind = 'late_cancel_charge' THEN
      -- Serialize with refund completion before the aggregate's statement
      -- snapshot, so a concurrent completed refund cannot be overwritten.
      PERFORM 1 FROM public.bookings b
       WHERE b.id = v_operation.booking_id AND b.salon_id = p_salon_id FOR UPDATE;
      -- A later payment.updated event can follow a completed refund. Rebuild
      -- the projection from this payment's succeeded refund ledger children;
      -- never erase refund truth just because the parent remains COMPLETED.
      UPDATE public.bookings b SET
        late_cancel_charge_status = CASE WHEN refunds.cents = v_operation.amount_cents
          THEN 'refunded' ELSE 'charged' END,
        late_cancel_payment_id = p_provider_payment_id,
        late_cancel_charged_cents = v_operation.amount_cents,
        late_cancel_refunded_cents = refunds.cents,
        late_cancel_refund_status = CASE WHEN refunds.cents = 0 THEN 'none'
          WHEN refunds.cents = v_operation.amount_cents THEN 'full' ELSE 'partial' END,
        late_cancel_charge_occurrence_version = v_operation.operation_occurrence_version,
        late_cancel_payment_ledger_enforced_at = coalesce(
          b.late_cancel_payment_ledger_enforced_at, clock_timestamp()
        )
      FROM (
        SELECT coalesce(sum(child.amount_cents), 0)::integer AS cents
        FROM public.booking_payment_operations child
        WHERE child.parent_operation_id = v_operation.id
          AND child.operation_kind = 'late_cancel_refund' AND child.status = 'succeeded'
          AND child.salon_id = p_salon_id AND child.booking_id = v_operation.booking_id
          AND child.provider = v_operation.provider
          AND child.provider_account_fingerprint = v_operation.provider_account_fingerprint
          AND child.parent_payment_id = p_provider_payment_id
      ) refunds
       WHERE b.id = v_operation.booking_id AND b.salon_id = p_salon_id
         AND (b.late_cancel_charge_occurrence_version IS NULL
           OR b.late_cancel_charge_occurrence_version < v_operation.operation_occurrence_version
           OR (b.late_cancel_charge_occurrence_version = v_operation.operation_occurrence_version
             AND (b.late_cancel_payment_id IS NULL OR b.late_cancel_payment_id = p_provider_payment_id)));
    END IF;
    v_result_code := 'payment_applied';$new4$;
BEGIN
  IF (length(definition) - length(replace(definition, original, ''))) / length(original) <> 1 THEN
    RAISE EXCEPTION 'fee webhook completion prerequisite drift';
  END IF;
  EXECUTE replace(definition, original, replacement);
END
$patch4$;

-- Preserve no-show refund truth on later payment updates as well.
DO $patch5$
DECLARE
  definition text := pg_get_functiondef('public.record_square_payment_webhook_event(uuid,text,text,timestamp with time zone,text,text,text,text,integer,text,timestamp with time zone,text,text,text,text)'::regprocedure);
  original text := $old5$      UPDATE public.bookings b SET
        noshow_charge_status = 'charged', noshow_payment_id = p_provider_payment_id,
        noshow_charge_error = NULL
       WHERE b.id = v_operation.booking_id AND b.salon_id = p_salon_id;$old5$;
  replacement text := $new5$      PERFORM 1 FROM public.bookings b
       WHERE b.id = v_operation.booking_id AND b.salon_id = p_salon_id FOR UPDATE;
      UPDATE public.bookings b SET
        noshow_charge_status = CASE WHEN refunds.cents = v_operation.amount_cents
          THEN 'refunded' ELSE 'charged' END,
        noshow_payment_id = p_provider_payment_id,
        noshow_refunded_cents = refunds.cents,
        noshow_refund_status = CASE WHEN refunds.cents = 0 THEN 'none'
          WHEN refunds.cents = v_operation.amount_cents THEN 'full' ELSE 'partial' END,
        noshow_charge_error = NULL
      FROM (
        SELECT coalesce(sum(child.amount_cents), 0)::integer AS cents
        FROM public.booking_payment_operations child
        WHERE child.parent_operation_id = v_operation.id
          AND child.operation_kind = 'noshow_refund' AND child.status = 'succeeded'
          AND child.salon_id = p_salon_id AND child.booking_id = v_operation.booking_id
          AND child.provider = v_operation.provider
          AND child.provider_account_fingerprint = v_operation.provider_account_fingerprint
          AND child.parent_payment_id = p_provider_payment_id
      ) refunds
       WHERE b.id = v_operation.booking_id AND b.salon_id = p_salon_id
         AND (b.noshow_payment_id IS NULL OR b.noshow_payment_id = p_provider_payment_id);$new5$;
BEGIN
  IF (length(definition) - length(replace(definition, original, ''))) / length(original) <> 1 THEN
    RAISE EXCEPTION 'no-show webhook refund prerequisite drift';
  END IF;
  EXECUTE replace(definition, original, replacement);
END
$patch5$;

COMMIT;
