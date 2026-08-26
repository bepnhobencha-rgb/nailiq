\set ON_ERROR_STOP on

SELECT jsonb_build_object(
  'bookings_rows',count(*),
  'ledger_adopted_deposit_rows',count(*) FILTER (WHERE deposit_payment_ledger_enforced_at IS NOT NULL),
  'ledger_adopted_noshow_rows',count(*) FILTER (WHERE noshow_payment_ledger_enforced_at IS NOT NULL),
  'ledger_adopted_late_cancel_rows',count(*) FILTER (WHERE late_cancel_payment_ledger_enforced_at IS NOT NULL),
  'legacy_deposit_receipt_rows',count(*) FILTER (
    WHERE stripe_payment_intent_id IS NOT NULL OR square_payment_id IS NOT NULL),
  'legacy_noshow_receipt_rows',count(*) FILTER (WHERE noshow_payment_id IS NOT NULL)
) AS booking_payment_rollout_inventory
FROM public.bookings;

SELECT jsonb_build_object(
  'operation_rows',count(*),
  'active_rows',count(*) FILTER (WHERE status IN (
    'sending','pending_customer','pending_provider','reconciling','unknown')),
  'unbound_succeeded_deposits',count(*) FILTER (
    WHERE operation_kind='deposit_charge' AND status='succeeded' AND booking_id IS NULL),
  'expired_provider_attempts',count(*) FILTER (
    WHERE status IN ('sending','reconciling') AND lease_expires_at<=now()),
  'active_public_deposits_missing_request_fingerprint',count(*) FILTER (
    WHERE operation_kind='deposit_charge' AND booking_intent_idempotency_key IS NOT NULL
      AND status IN ('sending','pending_customer','pending_provider','reconciling','unknown','succeeded')
      AND public_request_fingerprint IS NULL),
  'table_bytes',pg_total_relation_size('public.booking_payment_operations'::regclass)
) AS payment_operation_inventory
FROM public.booking_payment_operations;

SELECT jsonb_build_object(
  'saga_rows',count(*),
  'refund_claimed',count(*) FILTER (WHERE status='refund_claimed'),
  'refund_pending',count(*) FILTER (WHERE status='refund_pending'),
  'refund_unknown',count(*) FILTER (WHERE status='refund_unknown'),
  'table_bytes',pg_total_relation_size('public.booking_cancel_deposit_refund_sagas'::regclass)
) AS cancellation_refund_saga_inventory
FROM public.booking_cancel_deposit_refund_sagas;

DO $preflight$
DECLARE v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad FROM (
    SELECT stripe_payment_intent_id FROM public.bookings
    WHERE stripe_payment_intent_id IS NOT NULL
    GROUP BY stripe_payment_intent_id HAVING count(*)>1
  ) d;
  RAISE NOTICE 'legacy duplicate Stripe payment IDs (report-only, not adopted): %',v_bad;
  SELECT count(*) INTO v_bad FROM (
    SELECT square_payment_id FROM public.bookings
    WHERE square_payment_id IS NOT NULL
    GROUP BY square_payment_id HAVING count(*)>1
  ) d;
  RAISE NOTICE 'legacy duplicate Square payment IDs (report-only, not adopted): %',v_bad;
  IF EXISTS(SELECT 1 FROM public.booking_payment_operations
    WHERE provider_idempotency_key IS NULL OR length(provider_idempotency_key)>45) THEN
    RAISE EXCEPTION 'invalid provider idempotency key in authoritative ledger';
  END IF;
  IF EXISTS(SELECT 1 FROM public.booking_payment_operations
    WHERE operation_kind='deposit_charge' AND booking_intent_idempotency_key IS NOT NULL
      AND status IN ('sending','pending_customer','pending_provider','reconciling','unknown','succeeded')
      AND public_request_fingerprint IS NULL) THEN
    RAISE EXCEPTION 'active public deposit lacks payload-bound replay fingerprint';
  END IF;
  IF EXISTS(SELECT 1 FROM public.booking_payment_operations
    WHERE operation_kind='deposit_charge' AND booking_id IS NOT NULL
      AND status='succeeded' AND booking_create_fingerprint IS NULL) THEN
    RAISE EXCEPTION 'bound public deposit lacks atomic booking-create fingerprint';
  END IF;
  IF EXISTS(SELECT 1 FROM public.booking_payment_operations
    WHERE status='succeeded' AND operation_kind IN (
      'deposit_charge','noshow_charge','late_cancel_charge')
      AND provider_payment_id IS NULL) THEN
    RAISE EXCEPTION 'succeeded charge missing provider receipt';
  END IF;
  IF EXISTS(SELECT 1 FROM public.booking_payment_operations
    WHERE status='succeeded' AND operation_kind IN (
      'deposit_refund','noshow_refund','late_cancel_refund')
      AND provider_refund_id IS NULL) THEN
    RAISE EXCEPTION 'succeeded refund missing provider receipt';
  END IF;
  IF EXISTS(SELECT 1 FROM public.booking_payment_operations
    WHERE delivery_mode='square_hosted_link'
      AND status IN ('pending_provider','succeeded')
      AND (provider_order_id IS NULL OR provider_link_id IS NULL OR provider_link_url IS NULL)) THEN
    RAISE EXCEPTION 'Square hosted link operation lacks exact link/order receipt';
  END IF;
  IF EXISTS(SELECT 1 FROM public.booking_payment_operations
    WHERE delivery_mode='public_customer_present'
      AND (provider<>'square' OR provider_material ? 'saved_card_id'
        OR provider_material ? 'customer_id'
        OR provider_material->>'provider_environment' NOT IN ('sandbox','production'))) THEN
    RAISE EXCEPTION 'public Square operation contains non-customer-present provider material';
  END IF;
  IF EXISTS(SELECT 1 FROM public.booking_payment_operations
    WHERE delivery_mode='square_hosted_link'
      AND provider_material->>'provider_environment' NOT IN ('sandbox','production')) THEN
    RAISE EXCEPTION 'Square hosted link operation lacks authoritative environment';
  END IF;
  IF EXISTS(SELECT 1 FROM public.booking_cancel_deposit_refund_sagas s
    LEFT JOIN public.booking_payment_operations o ON o.id=s.refund_operation_id
    WHERE o.id IS NULL OR o.booking_id IS DISTINCT FROM s.booking_id
      OR o.salon_id IS DISTINCT FROM s.salon_id OR o.operation_kind<>'deposit_refund') THEN
    RAISE EXCEPTION 'cancellation/refund saga is not bound to its exact refund operation';
  END IF;
END
$preflight$;

SELECT 'booking payment rollout preflight passed' AS result;
