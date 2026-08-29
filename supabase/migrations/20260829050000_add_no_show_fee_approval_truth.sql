-- No-show fee approval truth.
--
-- Attendance is already committed by booking_no_show_decisions. This migration
-- adds a separate human decision and immutable approval receipt. It does not
-- call a provider, send a notification, or enable payment dispatch.

CREATE TABLE public.booking_no_show_fee_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  no_show_decision_id uuid NOT NULL UNIQUE
    REFERENCES public.booking_no_show_decisions(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'approved_charge', 'waived', 'invalidated')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  group_scope text NOT NULL
    CHECK (group_scope IN ('booking_member', 'whole_party')),
  card_brand text NOT NULL CHECK (length(card_brand) BETWEEN 1 AND 64),
  card_last4 text NOT NULL CHECK (card_last4 ~ '^[0-9]{4}$'),
  consent_at timestamptz NOT NULL,
  consent_policy_version text NOT NULL
    CHECK (consent_policy_version ~ '^nsp_[0-9a-f]{64}$'),
  consent_snapshot_hash text NOT NULL
    CHECK (consent_snapshot_hash ~ '^[0-9a-f]{64}$'),
  ai_recommendation text NOT NULL DEFAULT 'review'
    CHECK (ai_recommendation IN ('charge', 'waive', 'review')),
  ai_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(ai_reason_codes) = 'array'),
  requested_by_user_id uuid,
  requested_by_role text NOT NULL
    CHECK (requested_by_role IN ('owner', 'admin', 'senior', 'receptionist')),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by_user_id uuid,
  decided_by_role text CHECK (decided_by_role IN ('owner', 'admin')),
  decided_at timestamptz,
  approval_request_id uuid UNIQUE,
  payment_operation_id uuid UNIQUE
    REFERENCES public.booking_payment_operations(id) ON DELETE RESTRICT,
  payment_status text NOT NULL DEFAULT 'not_authorized'
    CHECK (payment_status IN (
      'not_authorized', 'dispatch_blocked', 'dispatching',
      'pending_provider', 'unknown', 'succeeded', 'failed', 'waived'
    )),
  payment_error_code text CHECK (
    payment_error_code IS NULL OR payment_error_code ~ '^[a-z0-9_]{1,64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT booking_no_show_fee_reviews_decision_state_check CHECK (
    (state = 'pending' AND decided_at IS NULL AND decided_by_user_id IS NULL
      AND decided_by_role IS NULL AND approval_request_id IS NULL
      AND payment_status = 'not_authorized')
    OR (state = 'approved_charge' AND decided_at IS NOT NULL
      AND decided_by_user_id IS NOT NULL AND decided_by_role IS NOT NULL
      AND approval_request_id IS NOT NULL
      AND payment_status IN ('dispatch_blocked', 'dispatching', 'pending_provider', 'unknown', 'succeeded', 'failed'))
    OR (state = 'waived' AND decided_at IS NOT NULL
      AND decided_by_user_id IS NOT NULL AND decided_by_role IS NOT NULL
      AND approval_request_id IS NOT NULL AND payment_status = 'waived')
    OR state = 'invalidated'
  )
);

CREATE INDEX booking_no_show_fee_reviews_salon_state_idx
  ON public.booking_no_show_fee_reviews (salon_id, state, requested_at DESC);
CREATE INDEX booking_no_show_fee_reviews_booking_idx
  ON public.booking_no_show_fee_reviews (salon_id, booking_id, created_at DESC);

CREATE TABLE public.booking_no_show_fee_approval_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE RESTRICT,
  review_id uuid NOT NULL UNIQUE
    REFERENCES public.booking_no_show_fee_reviews(id) ON DELETE RESTRICT,
  no_show_decision_id uuid NOT NULL UNIQUE
    REFERENCES public.booking_no_show_decisions(id) ON DELETE RESTRICT,
  approval_request_id uuid NOT NULL UNIQUE,
  action text NOT NULL CHECK (action IN ('charge', 'waive')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  group_scope text NOT NULL CHECK (group_scope IN ('booking_member', 'whole_party')),
  card_brand text NOT NULL,
  card_last4 text NOT NULL CHECK (card_last4 ~ '^[0-9]{4}$'),
  consent_at timestamptz NOT NULL,
  consent_policy_version text NOT NULL
    CHECK (consent_policy_version ~ '^nsp_[0-9a-f]{64}$'),
  consent_snapshot_hash text NOT NULL
    CHECK (consent_snapshot_hash ~ '^[0-9a-f]{64}$'),
  ai_recommendation text NOT NULL CHECK (ai_recommendation IN ('charge', 'waive', 'review')),
  ai_reason_codes jsonb NOT NULL CHECK (jsonb_typeof(ai_reason_codes) = 'array'),
  approved_by_user_id uuid NOT NULL,
  approved_by_role text NOT NULL CHECK (approved_by_role IN ('owner', 'admin')),
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX booking_no_show_fee_approval_receipts_salon_created_idx
  ON public.booking_no_show_fee_approval_receipts (salon_id, approved_at DESC);

ALTER TABLE public.booking_no_show_fee_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_no_show_fee_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE public.booking_no_show_fee_approval_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_no_show_fee_approval_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.booking_no_show_fee_reviews,
  public.booking_no_show_fee_approval_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.booking_no_show_fee_reviews TO service_role;
GRANT SELECT, INSERT ON TABLE public.booking_no_show_fee_approval_receipts TO service_role;

CREATE OR REPLACE FUNCTION public.prevent_no_show_fee_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $function$
BEGIN
  RAISE EXCEPTION 'no-show fee approval receipts are immutable' USING errcode = 'NI005';
END
$function$;

CREATE TRIGGER booking_no_show_fee_approval_receipts_immutable
  BEFORE UPDATE OR DELETE ON public.booking_no_show_fee_approval_receipts
  FOR EACH ROW EXECUTE FUNCTION public.prevent_no_show_fee_receipt_mutation();

CREATE OR REPLACE FUNCTION public.prevent_no_show_fee_review_material_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path TO '' AS $function$
BEGIN
  IF NEW.salon_id IS DISTINCT FROM OLD.salon_id
     OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.no_show_decision_id IS DISTINCT FROM OLD.no_show_decision_id
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.group_scope IS DISTINCT FROM OLD.group_scope
     OR NEW.card_brand IS DISTINCT FROM OLD.card_brand
     OR NEW.card_last4 IS DISTINCT FROM OLD.card_last4
     OR NEW.consent_at IS DISTINCT FROM OLD.consent_at
     OR NEW.consent_policy_version IS DISTINCT FROM OLD.consent_policy_version
     OR NEW.consent_snapshot_hash IS DISTINCT FROM OLD.consent_snapshot_hash
     OR NEW.ai_recommendation IS DISTINCT FROM OLD.ai_recommendation
     OR NEW.ai_reason_codes IS DISTINCT FROM OLD.ai_reason_codes
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.requested_by_role IS DISTINCT FROM OLD.requested_by_role
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'no-show fee review material is immutable' USING errcode = 'NI006';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER booking_no_show_fee_reviews_material_immutable
  BEFORE UPDATE ON public.booking_no_show_fee_reviews
  FOR EACH ROW EXECUTE FUNCTION public.prevent_no_show_fee_review_material_mutation();

CREATE OR REPLACE FUNCTION public.request_booking_no_show_fee_review(
  p_request_id uuid,
  p_decision_id uuid,
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_actor_role text,
  p_ai_recommendation text DEFAULT 'review',
  p_ai_reason_codes jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_actual_role text;
  v_decision public.booking_no_show_decisions%ROWTYPE;
  v_booking public.bookings%ROWTYPE;
  v_review public.booking_no_show_fee_reviews%ROWTYPE;
  v_meta jsonb;
  v_currency text;
  v_scope text;
  v_policy_version text;
BEGIN
  IF v_request_role <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_request_id IS NULL OR p_decision_id IS NULL OR p_salon_id IS NULL
     OR p_actor_user_id IS NULL
     OR p_ai_recommendation NOT IN ('charge', 'waive', 'review')
     OR jsonb_typeof(p_ai_reason_codes) <> 'array'
     OR jsonb_array_length(p_ai_reason_codes) > 10 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_request');
  END IF;

  SELECT sm.role INTO v_actual_role
    FROM public.salon_members sm
   WHERE sm.salon_id = p_salon_id AND sm.user_id = p_actor_user_id
     AND sm.role IN ('owner', 'admin', 'senior', 'receptionist')
   LIMIT 1;
  IF v_actual_role IS NULL OR v_actual_role IS DISTINCT FROM p_actor_role THEN
    RETURN jsonb_build_object('success', false, 'code', 'actor_unauthorized');
  END IF;

  SELECT r.* INTO v_review
    FROM public.booking_no_show_fee_reviews r
   WHERE r.id = p_request_id OR r.no_show_decision_id = p_decision_id
   ORDER BY (r.id = p_request_id) DESC LIMIT 1;
  IF FOUND THEN
    IF v_review.salon_id IS DISTINCT FROM p_salon_id
       OR v_review.no_show_decision_id IS DISTINCT FROM p_decision_id THEN
      RETURN jsonb_build_object('success', false, 'code', 'request_conflict');
    END IF;
    RETURN jsonb_build_object(
      'success', true, 'code', 'review_replay', 'review_id', v_review.id,
      'booking_id', v_review.booking_id, 'state', v_review.state,
      'payment_status', v_review.payment_status
    );
  END IF;

  SELECT d.* INTO v_decision
    FROM public.booking_no_show_decisions d
   WHERE d.id = p_decision_id AND d.salon_id = p_salon_id
   FOR UPDATE;
  IF NOT FOUND OR v_decision.state <> 'committed' THEN
    RETURN jsonb_build_object('success', false, 'code', 'no_show_not_committed');
  END IF;

  SELECT b.* INTO v_booking
    FROM public.bookings b
   WHERE b.id = v_decision.booking_id AND b.salon_id = p_salon_id
   FOR UPDATE;
  IF NOT FOUND OR v_booking.status <> 'no_show' THEN
    RETURN jsonb_build_object('success', false, 'code', 'booking_not_no_show');
  END IF;
  IF v_booking.deposit_status IN ('held', 'paid') THEN
    RETURN jsonb_build_object('success', false, 'code', 'deposit_already_protects_booking');
  END IF;
  v_meta := v_booking.noshow_consent_meta;
  v_currency := upper(trim(coalesce(v_meta ->> 'currency', '')));
  v_scope := coalesce(v_meta ->> 'scope', '');
  v_policy_version := coalesce(v_meta ->> 'policyVersion', '');
  IF v_booking.noshow_fee_cents IS NULL OR v_booking.noshow_fee_cents <= 0
     OR nullif(trim(coalesce(v_booking.noshow_card_id, '')), '') IS NULL
     OR v_booking.noshow_consent_at IS NULL
     OR v_meta IS NULL OR jsonb_typeof(v_meta) <> 'object'
     OR v_currency !~ '^[A-Z]{3}$'
     OR v_scope NOT IN ('booking_member', 'whole_party')
     OR v_policy_version !~ '^nsp_[0-9a-f]{64}$'
     OR (CASE
          WHEN coalesce(v_meta ->> 'feeCents', '') ~ '^[0-9]+$'
            THEN (v_meta ->> 'feeCents')::integer
          ELSE NULL
        END) IS DISTINCT FROM v_booking.noshow_fee_cents
     OR coalesce(v_booking.noshow_card_last4, '') !~ '^[0-9]{4}$'
     OR nullif(trim(coalesce(v_booking.noshow_card_brand, '')), '') IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'consent_not_charge_ready');
  END IF;

  INSERT INTO public.booking_no_show_fee_reviews (
    id, salon_id, booking_id, no_show_decision_id, amount_cents, currency,
    group_scope, card_brand, card_last4, consent_at, consent_policy_version,
    consent_snapshot_hash, ai_recommendation, ai_reason_codes,
    requested_by_user_id, requested_by_role
  ) VALUES (
    p_request_id, p_salon_id, v_booking.id, v_decision.id,
    v_booking.noshow_fee_cents, v_currency, v_scope,
    trim(v_booking.noshow_card_brand), v_booking.noshow_card_last4,
    v_booking.noshow_consent_at, v_policy_version,
    encode(extensions.digest(convert_to(v_meta::text, 'UTF8'), 'sha256'), 'hex'),
    p_ai_recommendation, p_ai_reason_codes, p_actor_user_id, v_actual_role
  ) RETURNING * INTO v_review;

  INSERT INTO public.booking_events (
    booking_id, salon_id, actor_user_id, actor_role, event_type, payload
  ) VALUES (
    v_booking.id, p_salon_id, p_actor_user_id, v_actual_role,
    'booking_no_show_fee_review_requested',
    jsonb_build_object(
      'review_id', v_review.id, 'decision_id', v_decision.id,
      'amount_cents', v_review.amount_cents, 'currency', v_review.currency,
      'ai_recommendation', v_review.ai_recommendation,
      'money_movement', 'not_authorized'
    )
  );

  RETURN jsonb_build_object(
    'success', true, 'code', 'review_created', 'review_id', v_review.id,
    'booking_id', v_review.booking_id, 'state', v_review.state,
    'payment_status', v_review.payment_status
  );
EXCEPTION WHEN unique_violation THEN
  SELECT r.* INTO v_review FROM public.booking_no_show_fee_reviews r
   WHERE r.no_show_decision_id = p_decision_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true, 'code', 'review_replay', 'review_id', v_review.id,
      'booking_id', v_review.booking_id, 'state', v_review.state,
      'payment_status', v_review.payment_status
    );
  END IF;
  RAISE;
END
$function$;

CREATE OR REPLACE FUNCTION public.ensure_booking_no_show_fee_review(
  p_decision_id uuid,
  p_salon_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_decision public.booking_no_show_decisions%ROWTYPE;
BEGIN
  IF v_request_role <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  SELECT d.* INTO v_decision
    FROM public.booking_no_show_decisions d
   WHERE d.id = p_decision_id AND d.salon_id = p_salon_id;
  IF NOT FOUND OR v_decision.state <> 'committed' THEN
    RETURN jsonb_build_object('success', false, 'code', 'no_show_not_committed');
  END IF;
  IF v_decision.requested_by_user_id IS NULL
     OR v_decision.requested_by_role = 'demo_cookie' THEN
    RETURN jsonb_build_object('success', false, 'code', 'review_actor_unavailable');
  END IF;
  RETURN public.request_booking_no_show_fee_review(
    v_decision.id,
    v_decision.id,
    v_decision.salon_id,
    v_decision.requested_by_user_id,
    v_decision.requested_by_role,
    'review',
    jsonb_build_array('attendance_committed', 'owner_review_required')
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.decide_booking_no_show_fee_review(
  p_review_id uuid,
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_actor_role text,
  p_approval_request_id uuid,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_actual_role text;
  v_review public.booking_no_show_fee_reviews%ROWTYPE;
  v_receipt public.booking_no_show_fee_approval_receipts%ROWTYPE;
BEGIN
  IF v_request_role <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_review_id IS NULL OR p_salon_id IS NULL OR p_actor_user_id IS NULL
     OR p_approval_request_id IS NULL OR p_action NOT IN ('charge', 'waive') THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_request');
  END IF;
  SELECT sm.role INTO v_actual_role FROM public.salon_members sm
   WHERE sm.salon_id = p_salon_id AND sm.user_id = p_actor_user_id
     AND sm.role IN ('owner', 'admin') LIMIT 1;
  IF v_actual_role IS NULL OR v_actual_role IS DISTINCT FROM p_actor_role THEN
    RETURN jsonb_build_object('success', false, 'code', 'approval_unauthorized');
  END IF;

  SELECT r.* INTO v_review FROM public.booking_no_show_fee_reviews r
   WHERE r.id = p_review_id AND r.salon_id = p_salon_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'review_not_found');
  END IF;
  IF v_review.state <> 'pending' THEN
    SELECT a.* INTO v_receipt FROM public.booking_no_show_fee_approval_receipts a
     WHERE a.review_id = v_review.id;
    IF FOUND AND v_receipt.approval_request_id = p_approval_request_id
       AND v_receipt.action = p_action THEN
      RETURN jsonb_build_object(
        'success', true, 'code', 'decision_replay', 'review_id', v_review.id,
        'state', v_review.state, 'payment_status', v_review.payment_status
      );
    END IF;
    RETURN jsonb_build_object('success', false, 'code', 'decision_conflict');
  END IF;

  INSERT INTO public.booking_no_show_fee_approval_receipts (
    salon_id, booking_id, review_id, no_show_decision_id, approval_request_id,
    action, amount_cents, currency, group_scope, card_brand, card_last4,
    consent_at, consent_policy_version, consent_snapshot_hash,
    ai_recommendation, ai_reason_codes, approved_by_user_id, approved_by_role
  ) VALUES (
    v_review.salon_id, v_review.booking_id, v_review.id,
    v_review.no_show_decision_id, p_approval_request_id, p_action,
    v_review.amount_cents, v_review.currency, v_review.group_scope,
    v_review.card_brand, v_review.card_last4, v_review.consent_at,
    v_review.consent_policy_version, v_review.consent_snapshot_hash,
    v_review.ai_recommendation, v_review.ai_reason_codes,
    p_actor_user_id, v_actual_role
  ) RETURNING * INTO v_receipt;

  UPDATE public.booking_no_show_fee_reviews r
     SET state = CASE WHEN p_action = 'charge' THEN 'approved_charge' ELSE 'waived' END,
         decided_by_user_id = p_actor_user_id,
         decided_by_role = v_actual_role,
         decided_at = v_receipt.approved_at,
         approval_request_id = p_approval_request_id,
         payment_status = CASE WHEN p_action = 'charge' THEN 'dispatch_blocked' ELSE 'waived' END,
         updated_at = clock_timestamp()
   WHERE r.id = v_review.id
   RETURNING * INTO v_review;

  INSERT INTO public.booking_events (
    booking_id, salon_id, actor_user_id, actor_role, event_type, payload
  ) VALUES (
    v_review.booking_id, v_review.salon_id, p_actor_user_id, v_actual_role,
    'booking_no_show_fee_decided',
    jsonb_build_object(
      'review_id', v_review.id, 'receipt_id', v_receipt.id,
      'action', p_action, 'amount_cents', v_review.amount_cents,
      'currency', v_review.currency,
      'money_movement', CASE WHEN p_action = 'charge' THEN 'approved_not_dispatched' ELSE 'waived' END
    )
  );

  RETURN jsonb_build_object(
    'success', true, 'code', 'decision_recorded', 'review_id', v_review.id,
    'receipt_id', v_receipt.id, 'state', v_review.state,
    'payment_status', v_review.payment_status
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.authorize_approved_no_show_fee_dispatch(
  p_review_id uuid,
  p_salon_id uuid,
  p_actor_user_id uuid,
  p_actor_role text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_actual_role text;
  v_review public.booking_no_show_fee_reviews%ROWTYPE;
BEGIN
  IF v_request_role <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  SELECT sm.role INTO v_actual_role FROM public.salon_members sm
   WHERE sm.salon_id = p_salon_id AND sm.user_id = p_actor_user_id
     AND sm.role IN ('owner', 'admin') LIMIT 1;
  IF v_actual_role IS NULL OR v_actual_role IS DISTINCT FROM p_actor_role THEN
    RETURN jsonb_build_object('success', false, 'code', 'dispatch_unauthorized');
  END IF;
  SELECT r.* INTO v_review FROM public.booking_no_show_fee_reviews r
   WHERE r.id = p_review_id AND r.salon_id = p_salon_id FOR UPDATE;
  IF NOT FOUND OR v_review.state <> 'approved_charge'
     OR v_review.approval_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'charge_not_approved');
  END IF;
  IF v_review.payment_status = 'succeeded' THEN
    RETURN jsonb_build_object(
      'success', true, 'code', 'dispatch_replay', 'booking_id', v_review.booking_id,
      'request_id', v_review.approval_request_id, 'amount_cents', v_review.amount_cents,
      'currency', v_review.currency, 'payment_operation_id', v_review.payment_operation_id
    );
  END IF;
  IF v_review.payment_status = 'failed' THEN
    RETURN jsonb_build_object('success', false, 'code', 'charge_failed_no_blind_retry');
  END IF;
  UPDATE public.booking_no_show_fee_reviews r
     SET payment_status = 'dispatching', payment_error_code = NULL,
         updated_at = clock_timestamp()
   WHERE r.id = v_review.id;
  RETURN jsonb_build_object(
    'success', true, 'code', 'dispatch_authorized', 'booking_id', v_review.booking_id,
    'request_id', v_review.approval_request_id, 'amount_cents', v_review.amount_cents,
    'currency', v_review.currency
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.record_approved_no_show_fee_dispatch_outcome(
  p_review_id uuid,
  p_salon_id uuid,
  p_payment_operation_id uuid,
  p_status text,
  p_error_code text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_review public.booking_no_show_fee_reviews%ROWTYPE;
  v_operation public.booking_payment_operations%ROWTYPE;
BEGIN
  IF v_request_role <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_status NOT IN ('pending_provider', 'unknown', 'succeeded', 'failed')
     OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z0-9_]{1,64}$') THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_outcome');
  END IF;
  SELECT r.* INTO v_review FROM public.booking_no_show_fee_reviews r
   WHERE r.id = p_review_id AND r.salon_id = p_salon_id FOR UPDATE;
  SELECT o.* INTO v_operation FROM public.booking_payment_operations o
   WHERE o.id = p_payment_operation_id AND o.salon_id = p_salon_id
     AND o.booking_id = v_review.booking_id AND o.operation_kind = 'noshow_charge';
  IF NOT FOUND OR v_review.state <> 'approved_charge'
     OR v_operation.request_id IS DISTINCT FROM v_review.approval_request_id
     OR v_operation.amount_cents IS DISTINCT FROM v_review.amount_cents
     OR v_operation.currency IS DISTINCT FROM v_review.currency THEN
    RETURN jsonb_build_object('success', false, 'code', 'operation_binding_mismatch');
  END IF;
  UPDATE public.booking_no_show_fee_reviews r
     SET payment_operation_id = v_operation.id,
         payment_status = p_status,
         payment_error_code = p_error_code,
         updated_at = clock_timestamp()
   WHERE r.id = v_review.id;
  RETURN jsonb_build_object(
    'success', true, 'code', 'outcome_recorded', 'review_id', v_review.id,
    'payment_operation_id', v_operation.id, 'payment_status', p_status
  );
END
$function$;

REVOKE ALL ON FUNCTION public.prevent_no_show_fee_receipt_mutation(),
  public.prevent_no_show_fee_review_material_mutation(),
  public.request_booking_no_show_fee_review(uuid,uuid,uuid,uuid,text,text,jsonb),
  public.ensure_booking_no_show_fee_review(uuid,uuid),
  public.decide_booking_no_show_fee_review(uuid,uuid,uuid,text,uuid,text),
  public.authorize_approved_no_show_fee_dispatch(uuid,uuid,uuid,text),
  public.record_approved_no_show_fee_dispatch_outcome(uuid,uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.request_booking_no_show_fee_review(uuid,uuid,uuid,uuid,text,text,jsonb),
  public.ensure_booking_no_show_fee_review(uuid,uuid),
  public.decide_booking_no_show_fee_review(uuid,uuid,uuid,text,uuid,text),
  public.authorize_approved_no_show_fee_dispatch(uuid,uuid,uuid,text),
  public.record_approved_no_show_fee_dispatch_outcome(uuid,uuid,uuid,text,text)
  TO service_role;

COMMENT ON TABLE public.booking_no_show_fee_reviews IS
  'Separate no-show fee decision state. Attendance never implies money movement.';
COMMENT ON TABLE public.booking_no_show_fee_approval_receipts IS
  'Immutable owner/admin charge-or-waive receipt with exact consent and policy evidence.';

-- Durable Square payment delivery truth. Only the PII-free material needed to
-- bind a payment to one authoritative operation is retained.
CREATE TABLE public.square_payment_webhook_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  provider_account_fingerprint text NOT NULL
    CHECK (provider_account_fingerprint ~ '^[0-9a-f]{64}$'),
  event_id text NOT NULL CHECK (
    length(event_id) BETWEEN 1 AND 255 AND event_id ~ '^[[:graph:]]+$'
  ),
  event_type text NOT NULL CHECK (event_type IN ('payment.created', 'payment.updated')),
  occurred_at timestamptz NOT NULL,
  payment_updated_at timestamptz NOT NULL,
  provider_payment_id text NOT NULL CHECK (
    length(provider_payment_id) BETWEEN 1 AND 255
      AND provider_payment_id ~ '^[[:graph:]]+$'
  ),
  provider_status text NOT NULL CHECK (
    provider_status IN ('APPROVED', 'PENDING', 'COMPLETED', 'CANCELED', 'FAILED')
  ),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  location_id text NOT NULL CHECK (
    length(location_id) BETWEEN 1 AND 255 AND location_id ~ '^[[:graph:]]+$'
  ),
  reference_id text CHECK (
    reference_id IS NULL OR (
      length(reference_id) BETWEEN 1 AND 255 AND reference_id ~ '^[[:graph:]]+$'
    )
  ),
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  material_fingerprint text NOT NULL CHECK (material_fingerprint ~ '^[0-9a-f]{64}$'),
  operation_id uuid REFERENCES public.booking_payment_operations(id) ON DELETE RESTRICT,
  result_code text,
  applied_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider_account_fingerprint, event_id)
);

CREATE INDEX square_payment_webhook_inbox_operation_revision_idx
  ON public.square_payment_webhook_inbox (
    operation_id, payment_updated_at DESC, received_at DESC, event_id DESC
  ) WHERE operation_id IS NOT NULL;
CREATE INDEX square_payment_webhook_inbox_unmatched_idx
  ON public.square_payment_webhook_inbox (received_at, id)
  WHERE operation_id IS NULL;

ALTER TABLE public.square_payment_webhook_inbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.square_payment_webhook_inbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.square_payment_webhook_inbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.square_payment_webhook_inbox TO service_role;

CREATE OR REPLACE FUNCTION public.record_square_payment_webhook_event(
  p_salon_id uuid,
  p_event_id text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_payload_fingerprint text,
  p_provider_payment_id text,
  p_location_id text,
  p_provider_status text,
  p_amount_cents integer,
  p_currency text,
  p_payment_updated_at timestamptz,
  p_reference_id text,
  p_merchant_id text,
  p_application_id text,
  p_environment text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_integration public.square_integrations%ROWTYPE;
  v_account_fingerprint text;
  v_material jsonb;
  v_material_fingerprint text;
  v_inbox public.square_payment_webhook_inbox%ROWTYPE;
  v_operation public.booking_payment_operations%ROWTYPE;
  v_latest public.square_payment_webhook_inbox%ROWTYPE;
  v_booking_id uuid;
  v_candidate_id uuid;
  v_candidate_count integer;
  v_result_code text;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_salon_id IS NULL
     OR p_event_id IS NULL OR length(p_event_id) NOT BETWEEN 1 AND 255
     OR p_event_id !~ '^[[:graph:]]+$'
     OR p_event_type NOT IN ('payment.created', 'payment.updated')
     OR p_occurred_at IS NULL OR NOT isfinite(p_occurred_at)
     OR p_payload_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_provider_payment_id IS NULL
     OR length(p_provider_payment_id) NOT BETWEEN 1 AND 255
     OR p_provider_payment_id !~ '^[[:graph:]]+$'
     OR p_location_id IS NULL OR length(p_location_id) NOT BETWEEN 1 AND 255
     OR p_location_id !~ '^[[:graph:]]+$'
     OR p_provider_status NOT IN ('APPROVED', 'PENDING', 'COMPLETED', 'CANCELED', 'FAILED')
     OR p_amount_cents IS NULL OR p_amount_cents <= 0
     OR p_currency !~ '^[A-Z]{3}$'
     OR p_payment_updated_at IS NULL OR NOT isfinite(p_payment_updated_at)
     OR (p_reference_id IS NOT NULL AND (
       length(p_reference_id) NOT BETWEEN 1 AND 255 OR p_reference_id !~ '^[[:graph:]]+$'
     ))
     OR p_merchant_id IS NULL OR p_merchant_id !~ '^[[:graph:]]+$'
     OR p_application_id IS NULL OR p_application_id !~ '^[[:graph:]]+$'
     OR p_environment NOT IN ('sandbox', 'production') THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_payment_event');
  END IF;

  SELECT * INTO v_integration FROM public.square_integrations
   WHERE salon_id = p_salon_id AND merchant_id = p_merchant_id
     AND location_id = p_location_id AND application_id = p_application_id
     AND environment = p_environment AND enabled IS TRUE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'provider_context_mismatch');
  END IF;
  v_account_fingerprint := encode(
    extensions.digest(convert_to(
      'square:' || p_merchant_id || ':' || p_location_id || ':' || p_environment,
      'UTF8'
    ), 'sha256'), 'hex'
  );
  v_material := jsonb_build_object(
    'event_id', p_event_id, 'event_type', p_event_type,
    'occurred_at', p_occurred_at, 'provider_payment_id', p_provider_payment_id,
    'location_id', p_location_id, 'provider_status', p_provider_status,
    'amount_cents', p_amount_cents, 'currency', p_currency,
    'payment_updated_at', p_payment_updated_at,
    'reference_id', p_reference_id, 'merchant_id', p_merchant_id,
    'application_id', p_application_id, 'environment', p_environment
  );
  v_material_fingerprint := encode(
    extensions.digest(convert_to(v_material::text, 'UTF8'), 'sha256'), 'hex'
  );

  INSERT INTO public.square_payment_webhook_inbox (
    salon_id, provider_account_fingerprint, event_id, event_type, occurred_at,
    payment_updated_at, provider_payment_id, provider_status, amount_cents,
    currency, location_id, reference_id, payload_fingerprint, material_fingerprint
  ) VALUES (
    p_salon_id, v_account_fingerprint, p_event_id, p_event_type, p_occurred_at,
    p_payment_updated_at, p_provider_payment_id, p_provider_status,
    p_amount_cents, p_currency, p_location_id, p_reference_id,
    p_payload_fingerprint, v_material_fingerprint
  ) ON CONFLICT (provider_account_fingerprint, event_id) DO NOTHING;

  SELECT * INTO v_inbox FROM public.square_payment_webhook_inbox
   WHERE provider_account_fingerprint = v_account_fingerprint
     AND event_id = p_event_id FOR UPDATE;
  IF v_inbox.material_fingerprint IS DISTINCT FROM v_material_fingerprint
     OR v_inbox.payload_fingerprint IS DISTINCT FROM p_payload_fingerprint THEN
    RETURN jsonb_build_object('success', false, 'code', 'event_conflict');
  END IF;
  IF v_inbox.applied_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true, 'code', 'event_replay', 'event_id', p_event_id,
      'result_code', v_inbox.result_code
    );
  END IF;

  SELECT o.* INTO v_operation FROM public.booking_payment_operations o
   WHERE o.provider = 'square'
     AND o.provider_account_fingerprint = v_account_fingerprint
     AND o.provider_payment_id = p_provider_payment_id
   LIMIT 1 FOR UPDATE;

  IF NOT FOUND AND p_reference_id ~ '^booking:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    v_booking_id := substring(p_reference_id FROM 9)::uuid;
    SELECT count(*), (array_agg(o.id ORDER BY o.created_at, o.id))[1]
      INTO v_candidate_count, v_candidate_id
      FROM public.booking_payment_operations o
     WHERE o.salon_id = p_salon_id AND o.booking_id = v_booking_id
       AND o.provider = 'square'
       AND o.provider_account_fingerprint = v_account_fingerprint
       AND o.operation_kind = 'noshow_charge'
       AND o.amount_cents = p_amount_cents AND o.currency = p_currency
       AND o.status IN ('sending', 'pending_provider', 'reconciling', 'unknown', 'succeeded');
    IF v_candidate_count = 1 THEN
      SELECT o.* INTO v_operation FROM public.booking_payment_operations o
       WHERE o.id = v_candidate_id FOR UPDATE;
    END IF;
  END IF;
  IF v_operation.id IS NULL THEN
    UPDATE public.square_payment_webhook_inbox
       SET result_code = 'operation_not_found'
     WHERE id = v_inbox.id;
    RETURN jsonb_build_object(
      'success', false, 'code', 'operation_not_found', 'event_id', p_event_id
    );
  END IF;
  IF v_operation.salon_id IS DISTINCT FROM p_salon_id
     OR v_operation.amount_cents IS DISTINCT FROM p_amount_cents
     OR v_operation.currency IS DISTINCT FROM p_currency
     OR v_operation.provider_material ->> 'provider_location_id' IS DISTINCT FROM p_location_id
     OR v_operation.provider_material ->> 'provider_environment' IS DISTINCT FROM p_environment THEN
    RETURN jsonb_build_object('success', false, 'code', 'provider_binding_mismatch');
  END IF;

  SELECT i.* INTO v_latest FROM public.square_payment_webhook_inbox i
   WHERE i.operation_id = v_operation.id AND i.applied_at IS NOT NULL
   ORDER BY i.payment_updated_at DESC, i.received_at DESC, i.event_id DESC LIMIT 1;
  IF FOUND AND v_latest.payment_updated_at > p_payment_updated_at THEN
    UPDATE public.square_payment_webhook_inbox
       SET operation_id = v_operation.id, result_code = 'stale_event_ignored',
           applied_at = clock_timestamp()
     WHERE id = v_inbox.id;
    RETURN jsonb_build_object('success', true, 'code', 'stale_event_ignored', 'event_id', p_event_id);
  END IF;
  IF FOUND AND v_latest.payment_updated_at = p_payment_updated_at
     AND v_latest.provider_status IS DISTINCT FROM p_provider_status THEN
    RETURN jsonb_build_object('success', false, 'code', 'revision_conflict');
  END IF;

  IF p_provider_status = 'COMPLETED' THEN
    IF v_operation.status IN ('failed', 'compensated') THEN
      RETURN jsonb_build_object('success', false, 'code', 'terminal_state_conflict');
    END IF;
    UPDATE public.booking_payment_operations o SET
      provider_payment_id = p_provider_payment_id,
      provider_status = p_provider_status,
      status = 'succeeded', failure_disposition = NULL, error_code = NULL,
      result_json = coalesce(o.result_json, '{}'::jsonb) || jsonb_build_object(
        'provider_payment_id', p_provider_payment_id,
        'completion_source', 'square_payment_webhook'
      ),
      attempt_token = NULL, lease_expires_at = NULL, next_reconcile_at = NULL,
      completed_at = coalesce(o.completed_at, clock_timestamp()),
      updated_at = clock_timestamp()
     WHERE o.id = v_operation.id;
    IF v_operation.operation_kind = 'noshow_charge' THEN
      UPDATE public.bookings b SET
        noshow_charge_status = 'charged', noshow_payment_id = p_provider_payment_id,
        noshow_charge_error = NULL
       WHERE b.id = v_operation.booking_id AND b.salon_id = p_salon_id;
      UPDATE public.booking_no_show_fee_reviews r SET
        payment_operation_id = v_operation.id, payment_status = 'succeeded',
        payment_error_code = NULL, updated_at = clock_timestamp()
       WHERE r.salon_id = p_salon_id AND r.booking_id = v_operation.booking_id
         AND r.state = 'approved_charge';
    END IF;
    v_result_code := 'payment_applied';
  ELSIF p_provider_status IN ('CANCELED', 'FAILED') THEN
    IF v_operation.status = 'succeeded' THEN
      RETURN jsonb_build_object('success', false, 'code', 'terminal_state_conflict');
    END IF;
    UPDATE public.booking_payment_operations o SET
      provider_payment_id = p_provider_payment_id,
      provider_status = p_provider_status, status = 'failed',
      failure_disposition = 'terminal', error_code = 'provider_rejected',
      attempt_token = NULL, lease_expires_at = NULL, next_reconcile_at = NULL,
      updated_at = clock_timestamp()
     WHERE o.id = v_operation.id;
    UPDATE public.booking_no_show_fee_reviews r SET
      payment_operation_id = v_operation.id, payment_status = 'failed',
      payment_error_code = 'provider_rejected', updated_at = clock_timestamp()
     WHERE r.salon_id = p_salon_id AND r.booking_id = v_operation.booking_id
       AND r.state = 'approved_charge';
    v_result_code := 'payment_failed';
  ELSE
    IF v_operation.status NOT IN ('succeeded', 'failed', 'compensated') THEN
      UPDATE public.booking_payment_operations o SET
        provider_payment_id = p_provider_payment_id,
        provider_status = p_provider_status, status = 'pending_provider',
        failure_disposition = NULL, error_code = NULL,
        attempt_token = NULL, lease_expires_at = NULL,
        next_reconcile_at = clock_timestamp() + interval '2 minutes',
        updated_at = clock_timestamp()
       WHERE o.id = v_operation.id;
      UPDATE public.booking_no_show_fee_reviews r SET
        payment_operation_id = v_operation.id, payment_status = 'pending_provider',
        payment_error_code = NULL, updated_at = clock_timestamp()
       WHERE r.salon_id = p_salon_id AND r.booking_id = v_operation.booking_id
         AND r.state = 'approved_charge';
    END IF;
    v_result_code := 'payment_pending';
  END IF;

  UPDATE public.square_payment_webhook_inbox SET
    operation_id = v_operation.id, result_code = v_result_code,
    applied_at = clock_timestamp()
   WHERE id = v_inbox.id;
  RETURN jsonb_build_object(
    'success', true, 'code', v_result_code, 'event_id', p_event_id,
    'operation_id', v_operation.id
  );
END
$function$;

REVOKE ALL ON FUNCTION public.record_square_payment_webhook_event(
  uuid,text,text,timestamptz,text,text,text,text,integer,text,timestamptz,
  text,text,text,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_square_payment_webhook_event(
  uuid,text,text,timestamptz,text,text,text,text,integer,text,timestamptz,
  text,text,text,text
) TO service_role;

COMMENT ON TABLE public.square_payment_webhook_inbox IS
  'Signature-verified, PII-free Square payment revisions with exact provider and operation binding.';
