-- P0 cancellation-fee safety boundary.
--
-- Policy implemented here:
--   * less than 24h notice can be fee-eligible;
--   * a booking originally made within that 24h window has a 15-minute
--     cancel/reschedule grace period;
--   * the late-cancel fee is capped at 20% of the booked-service snapshot;
--   * cancellation commits independently from fee review;
--   * only Owner/Admin can create an immutable approval receipt;
--   * approval remains dispatch-blocked until a separately gated money action.

CREATE OR REPLACE FUNCTION public.booking_late_cancellation_snapshot(
  p_booking public.bookings,
  p_salon public.salons,
  p_now timestamptz DEFAULT transaction_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $snapshot$
DECLARE
  v_window_hours integer := CASE
    WHEN coalesce(p_salon.self_cancel_window_hours, 0) > 0
      THEN p_salon.self_cancel_window_hours
    ELSE 24
  END;
  v_start_past boolean;
  v_current_within boolean;
  v_locked boolean;
  v_short_notice boolean;
  v_grace_ends_at timestamptz;
  v_grace_active boolean;
  v_within boolean;
  v_no_show_percent integer := greatest(0, coalesce(p_salon.noshow_fee_percent, 0));
  v_late_percent integer := least(
    20,
    greatest(0, coalesce(p_salon.self_cancel_fee_percent, p_salon.noshow_fee_percent, 0))
  );
  v_snapshot_cents integer := greatest(0, coalesce(p_booking.noshow_fee_cents, 0));
  v_fee_cents integer := 0;
  v_has_card boolean;
BEGIN
  v_start_past := p_booking.start_time_utc IS NULL OR p_booking.start_time_utc <= p_now;
  v_current_within := NOT v_start_past
    AND p_booking.start_time_utc < p_now + make_interval(hours => v_window_hours);
  v_locked := p_booking.self_cancel_fee_locked_at IS NOT NULL;
  v_short_notice := p_booking.start_time_utc IS NOT NULL
    AND p_booking.created_at IS NOT NULL
    AND p_booking.start_time_utc > p_booking.created_at
    AND p_booking.start_time_utc <= p_booking.created_at
      + make_interval(hours => v_window_hours);
  v_grace_ends_at := CASE WHEN v_short_notice
    THEN p_booking.created_at + interval '15 minutes'
    ELSE NULL
  END;
  v_grace_active := v_grace_ends_at IS NOT NULL AND p_now <= v_grace_ends_at;
  v_within := NOT v_start_past AND NOT v_grace_active
    AND (v_current_within OR v_locked);

  IF v_locked AND coalesce(p_booking.self_cancel_fee_locked_cents, 0) > 0 THEN
    v_fee_cents := p_booking.self_cancel_fee_locked_cents;
    IF v_no_show_percent > 0 THEN
      v_fee_cents := least(
        v_fee_cents,
        round(v_snapshot_cents::numeric * 20::numeric / v_no_show_percent::numeric)::integer
      );
    ELSE
      v_fee_cents := 0;
    END IF;
  ELSIF v_no_show_percent > 0 THEN
    v_fee_cents := round(
      v_snapshot_cents::numeric * v_late_percent::numeric / v_no_show_percent::numeric
    )::integer;
  END IF;

  v_has_card := nullif(trim(coalesce(p_booking.noshow_card_id, '')), '') IS NOT NULL
    AND nullif(trim(coalesce(p_booking.noshow_customer_id, '')), '') IS NOT NULL
    AND p_booking.noshow_consent_at IS NOT NULL
    AND nullif(trim(coalesce(p_booking.noshow_consent_meta->>'policyVersion', '')), '') IS NOT NULL
    AND v_fee_cents > 0
    AND coalesce(p_booking.noshow_charge_status, '') <> 'charged';

  RETURN jsonb_build_object(
    'start_past', v_start_past,
    'current_within_window', v_current_within,
    'short_notice_booking', v_short_notice,
    'grace_active', v_grace_active,
    'grace_ends_at', v_grace_ends_at,
    'policy_locked_by_reschedule', v_locked,
    'within_window', v_within,
    'has_chargeable_card', v_has_card,
    'will_charge', coalesce(p_salon.self_cancel_fee_enabled, false)
      AND v_within AND v_has_card,
    'fee_cents', v_fee_cents,
    'fee_percent', v_late_percent,
    'max_fee_percent', 20,
    'card_last4', p_booking.noshow_card_last4,
    'card_brand', p_booking.noshow_card_brand,
    'currency', upper(coalesce(nullif(trim(p_salon.currency_code), ''), 'CAD')),
    'consent_policy_version', nullif(trim(coalesce(
      p_booking.noshow_consent_meta->>'policyVersion', ''
    )), '')
  );
END;
$snapshot$;

REVOKE ALL ON FUNCTION public.booking_late_cancellation_snapshot(
  public.bookings, public.salons, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_late_cancellation_snapshot(
  public.bookings, public.salons, timestamptz
) TO service_role;

CREATE OR REPLACE FUNCTION public.booking_management_cancel_preview(
  p_salon_id uuid,
  p_booking_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $preview$
DECLARE
  v_booking public.bookings%ROWTYPE;
  v_salon public.salons%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_booking
  FROM public.bookings
  WHERE id = p_booking_id AND salon_id = p_salon_id;
  SELECT * INTO STRICT v_salon
  FROM public.salons
  WHERE id = p_salon_id;
  RETURN public.booking_late_cancellation_snapshot(
    v_booking, v_salon, transaction_timestamp()
  );
END;
$preview$;

REVOKE ALL ON FUNCTION public.booking_management_cancel_preview(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_management_cancel_preview(uuid, uuid)
  TO service_role;

-- Defense in depth for every reschedule path. Legacy application code may try
-- to write a lock during the 15-minute grace; the database removes it. Outside
-- the grace, an excessive lock is clamped to the authoritative 20% ceiling.
CREATE OR REPLACE FUNCTION public.protect_late_cancellation_lock_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $guard$
DECLARE
  v_salon public.salons%ROWTYPE;
  v_snapshot jsonb;
  v_cap integer;
BEGIN
  IF OLD.self_cancel_fee_locked_at IS NOT NULL
     OR NEW.self_cancel_fee_locked_at IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO STRICT v_salon FROM public.salons WHERE id = OLD.salon_id;
  v_snapshot := public.booking_late_cancellation_snapshot(
    OLD, v_salon, transaction_timestamp()
  );
  IF coalesce((v_snapshot->>'grace_active')::boolean, false) THEN
    NEW.self_cancel_fee_locked_at := NULL;
    NEW.self_cancel_fee_locked_cents := NULL;
    NEW.self_cancel_fee_lock_reason := NULL;
    RETURN NEW;
  END IF;
  v_cap := greatest(0, coalesce((v_snapshot->>'fee_cents')::integer, 0));
  IF v_cap <= 0 THEN
    NEW.self_cancel_fee_locked_at := NULL;
    NEW.self_cancel_fee_locked_cents := NULL;
    NEW.self_cancel_fee_lock_reason := NULL;
  ELSE
    NEW.self_cancel_fee_locked_cents := least(
      greatest(0, coalesce(NEW.self_cancel_fee_locked_cents, 0)),
      v_cap
    );
  END IF;
  RETURN NEW;
END;
$guard$;

DROP TRIGGER IF EXISTS bookings_late_cancellation_lock_policy
  ON public.bookings;
CREATE TRIGGER bookings_late_cancellation_lock_policy
BEFORE UPDATE OF self_cancel_fee_locked_at, self_cancel_fee_locked_cents
ON public.bookings
FOR EACH ROW
EXECUTE FUNCTION public.protect_late_cancellation_lock_policy();

REVOKE ALL ON FUNCTION public.protect_late_cancellation_lock_policy()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.booking_late_cancellation_fee_reviews (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL UNIQUE REFERENCES public.bookings(id) ON DELETE RESTRICT,
  cancellation_occurrence_version bigint NOT NULL CHECK (cancellation_occurrence_version > 0),
  state text NOT NULL DEFAULT 'pending_review' CHECK (
    state IN ('pending_review', 'approved_charge', 'waived', 'invalidated')
  ),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  fee_percent integer NOT NULL CHECK (fee_percent BETWEEN 0 AND 20),
  card_brand text,
  card_last4 text NOT NULL CHECK (card_last4 ~ '^[0-9]{4}$'),
  consent_at timestamptz NOT NULL,
  consent_policy_version text NOT NULL,
  policy_snapshot jsonb NOT NULL CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  approval_request_id uuid,
  decided_by_user_id uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  decided_by_role text CHECK (decided_by_role IS NULL OR decided_by_role IN ('owner', 'admin')),
  decided_at timestamptz,
  payment_status text NOT NULL DEFAULT 'not_authorized' CHECK (
    payment_status IN (
      'not_authorized', 'dispatch_blocked', 'dispatching',
      'pending_provider', 'unknown', 'succeeded', 'failed'
    )
  ),
  payment_operation_id uuid REFERENCES public.booking_payment_operations(id) ON DELETE RESTRICT,
  payment_error_code text,
  requested_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT booking_late_cancel_review_occurrence_once
    UNIQUE (salon_id, booking_id, cancellation_occurrence_version),
  CONSTRAINT booking_late_cancel_review_decision_check CHECK (
    (state = 'pending_review' AND approval_request_id IS NULL
      AND decided_by_user_id IS NULL AND decided_by_role IS NULL
      AND decided_at IS NULL AND payment_status = 'not_authorized')
    OR (state = 'approved_charge' AND approval_request_id IS NOT NULL
      AND decided_by_user_id IS NOT NULL AND decided_by_role IN ('owner', 'admin')
      AND decided_at IS NOT NULL
      AND payment_status IN ('dispatch_blocked', 'dispatching', 'pending_provider',
        'unknown', 'succeeded', 'failed'))
    OR (state IN ('waived', 'invalidated') AND decided_by_user_id IS NOT NULL
      AND decided_by_role IN ('owner', 'admin') AND decided_at IS NOT NULL
      AND payment_status = 'not_authorized')
  )
);

CREATE INDEX booking_late_cancel_fee_reviews_queue_idx
  ON public.booking_late_cancellation_fee_reviews
  (salon_id, state, requested_at DESC);

CREATE INDEX booking_late_cancel_fee_reviews_decider_idx
  ON public.booking_late_cancellation_fee_reviews (decided_by_user_id)
  WHERE decided_by_user_id IS NOT NULL;

CREATE INDEX booking_late_cancel_fee_reviews_payment_operation_idx
  ON public.booking_late_cancellation_fee_reviews (payment_operation_id)
  WHERE payment_operation_id IS NOT NULL;

CREATE TABLE public.booking_late_cancellation_fee_approval_receipts (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  review_id uuid NOT NULL UNIQUE
    REFERENCES public.booking_late_cancellation_fee_reviews(id) ON DELETE RESTRICT,
  approval_request_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('charge', 'waive')),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_role text NOT NULL CHECK (actor_role IN ('owner', 'admin')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  consent_policy_version text NOT NULL,
  policy_snapshot_hash text NOT NULL CHECK (policy_snapshot_hash ~ '^[0-9a-f]{64}$'),
  receipt_fingerprint text NOT NULL CHECK (receipt_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT booking_late_cancel_fee_approval_request_once
    UNIQUE (salon_id, approval_request_id)
);

CREATE INDEX booking_late_cancel_fee_receipts_actor_idx
  ON public.booking_late_cancellation_fee_approval_receipts (actor_user_id);

ALTER TABLE public.booking_late_cancellation_fee_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_late_cancellation_fee_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE public.booking_late_cancellation_fee_approval_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_late_cancellation_fee_approval_receipts FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.booking_late_cancellation_fee_reviews
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.booking_late_cancellation_fee_approval_receipts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.booking_late_cancellation_fee_reviews,
  public.booking_late_cancellation_fee_approval_receipts TO service_role;

CREATE POLICY "deny browser late cancellation fee reviews"
  ON public.booking_late_cancellation_fee_reviews AS RESTRICTIVE
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "deny browser late cancellation fee receipts"
  ON public.booking_late_cancellation_fee_approval_receipts AS RESTRICTIVE
  FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.prevent_late_cancellation_fee_receipt_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $immutable$
BEGIN
  RAISE EXCEPTION 'late cancellation fee approval receipts are immutable'
    USING ERRCODE = 'NI001';
END;
$immutable$;

CREATE TRIGGER booking_late_cancellation_fee_receipts_immutable
BEFORE UPDATE OR DELETE ON public.booking_late_cancellation_fee_approval_receipts
FOR EACH ROW EXECUTE FUNCTION public.prevent_late_cancellation_fee_receipt_mutation();

REVOKE ALL ON FUNCTION public.prevent_late_cancellation_fee_receipt_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

-- Central capture covers public web, voice, receptionist and any future path
-- that transitions an individual booking into cancelled. It cannot charge.
CREATE OR REPLACE FUNCTION public.capture_late_cancellation_fee_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $capture$
DECLARE
  v_salon public.salons%ROWTYPE;
  v_snapshot jsonb;
  v_version text;
BEGIN
  IF OLD.status NOT IN ('pending', 'confirmed', 'in_progress')
     OR NEW.status <> 'cancelled'
     OR NEW.group_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO STRICT v_salon FROM public.salons WHERE id = NEW.salon_id;
  v_snapshot := public.booking_late_cancellation_snapshot(
    OLD, v_salon, transaction_timestamp()
  );
  IF coalesce((v_snapshot->>'will_charge')::boolean, false) IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  v_version := nullif(trim(coalesce(v_snapshot->>'consent_policy_version', '')), '');
  IF v_version IS NULL
     OR coalesce(v_snapshot->>'card_last4', '') !~ '^[0-9]{4}$'
     OR coalesce((v_snapshot->>'fee_cents')::integer, 0) <= 0 THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.booking_late_cancellation_fee_reviews (
    salon_id, booking_id, cancellation_occurrence_version,
    amount_cents, currency, fee_percent, card_brand, card_last4,
    consent_at, consent_policy_version, policy_snapshot
  ) VALUES (
    NEW.salon_id,
    NEW.id,
    greatest(1, coalesce(NEW.customer_transition_version, 1)),
    (v_snapshot->>'fee_cents')::integer,
    v_snapshot->>'currency',
    (v_snapshot->>'fee_percent')::integer,
    v_snapshot->>'card_brand',
    v_snapshot->>'card_last4',
    OLD.noshow_consent_at,
    v_version,
    v_snapshot
  )
  ON CONFLICT (booking_id) DO NOTHING;
  RETURN NEW;
END;
$capture$;

DROP TRIGGER IF EXISTS bookings_capture_late_cancellation_fee_review
  ON public.bookings;
CREATE TRIGGER bookings_capture_late_cancellation_fee_review
AFTER UPDATE OF status ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.capture_late_cancellation_fee_review();

REVOKE ALL ON FUNCTION public.capture_late_cancellation_fee_review()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.decide_late_cancellation_fee_review(
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
AS $decide$
DECLARE
  v_request_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_member_role text;
  v_review public.booking_late_cancellation_fee_reviews%ROWTYPE;
  v_existing public.booking_late_cancellation_fee_approval_receipts%ROWTYPE;
  v_policy_hash text;
  v_fingerprint text;
BEGIN
  IF v_request_role <> 'service_role'
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_review_id IS NULL OR p_salon_id IS NULL OR p_actor_user_id IS NULL
     OR p_approval_request_id IS NULL OR p_action NOT IN ('charge', 'waive')
     OR p_actor_role NOT IN ('owner', 'admin') THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_request');
  END IF;
  SELECT m.role INTO v_member_role
  FROM public.salon_members m
  WHERE m.salon_id = p_salon_id AND m.user_id = p_actor_user_id
    AND m.role IN ('owner', 'admin')
  LIMIT 1;
  IF v_member_role IS NULL OR v_member_role IS DISTINCT FROM p_actor_role THEN
    RETURN jsonb_build_object('success', false, 'code', 'actor_unauthorized');
  END IF;
  SELECT * INTO v_existing
  FROM public.booking_late_cancellation_fee_approval_receipts r
  WHERE r.salon_id = p_salon_id
    AND r.approval_request_id = p_approval_request_id;
  IF FOUND THEN
    IF v_existing.review_id IS DISTINCT FROM p_review_id
       OR v_existing.action IS DISTINCT FROM p_action
       OR v_existing.actor_user_id IS DISTINCT FROM p_actor_user_id THEN
      RETURN jsonb_build_object('success', false, 'code', 'idempotency_mismatch');
    END IF;
    RETURN jsonb_build_object(
      'success', true, 'code', 'decision_replayed', 'review_id', p_review_id,
      'state', CASE WHEN p_action = 'charge' THEN 'approved_charge' ELSE 'waived' END,
      'payment_status', CASE WHEN p_action = 'charge'
        THEN 'dispatch_blocked' ELSE 'not_authorized' END
    );
  END IF;
  SELECT * INTO v_review
  FROM public.booking_late_cancellation_fee_reviews r
  WHERE r.id = p_review_id AND r.salon_id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'review_not_found');
  END IF;
  IF v_review.state <> 'pending_review' THEN
    RETURN jsonb_build_object('success', false, 'code', 'review_not_pending');
  END IF;
  v_policy_hash := encode(extensions.digest(
    convert_to(v_review.policy_snapshot::text, 'UTF8'), 'sha256'
  ), 'hex');
  v_fingerprint := encode(extensions.digest(convert_to(concat_ws('|',
    v_review.id::text, p_action, p_actor_user_id::text,
    v_review.amount_cents::text, v_review.currency,
    v_review.consent_policy_version, v_policy_hash,
    p_approval_request_id::text
  ), 'UTF8'), 'sha256'), 'hex');
  INSERT INTO public.booking_late_cancellation_fee_approval_receipts (
    salon_id, review_id, approval_request_id, action, actor_user_id, actor_role,
    amount_cents, currency, consent_policy_version, policy_snapshot_hash,
    receipt_fingerprint
  ) VALUES (
    p_salon_id, p_review_id, p_approval_request_id, p_action,
    p_actor_user_id, v_member_role, v_review.amount_cents, v_review.currency,
    v_review.consent_policy_version, v_policy_hash, v_fingerprint
  );
  UPDATE public.booking_late_cancellation_fee_reviews
  SET state = CASE WHEN p_action = 'charge' THEN 'approved_charge' ELSE 'waived' END,
      approval_request_id = p_approval_request_id,
      decided_by_user_id = p_actor_user_id,
      decided_by_role = v_member_role,
      decided_at = transaction_timestamp(),
      payment_status = CASE WHEN p_action = 'charge'
        THEN 'dispatch_blocked' ELSE 'not_authorized' END,
      updated_at = transaction_timestamp()
  WHERE id = p_review_id;
  RETURN jsonb_build_object(
    'success', true, 'code', 'decision_recorded', 'review_id', p_review_id,
    'state', CASE WHEN p_action = 'charge' THEN 'approved_charge' ELSE 'waived' END,
    'payment_status', CASE WHEN p_action = 'charge'
      THEN 'dispatch_blocked' ELSE 'not_authorized' END
  );
END;
$decide$;

REVOKE ALL ON FUNCTION public.decide_late_cancellation_fee_review(
  uuid, uuid, uuid, text, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decide_late_cancellation_fee_review(
  uuid, uuid, uuid, text, uuid, text
) TO service_role;

-- Upgrade the existing whole-party review to the same durable lifecycle. No
-- existing row becomes dispatchable; approved rows remain dispatch_blocked.
ALTER TABLE public.booking_group_cancellation_fee_reviews
  ADD COLUMN approval_request_id uuid,
  ADD COLUMN payment_operation_id uuid
    REFERENCES public.booking_payment_operations(id) ON DELETE RESTRICT,
  ADD COLUMN payment_error_code text;

ALTER TABLE public.booking_group_cancellation_fee_reviews
  DROP CONSTRAINT booking_group_cancellation_fee_reviews_payment_status_check,
  DROP CONSTRAINT booking_group_cancel_fee_review_decision_check;

ALTER TABLE public.booking_group_cancellation_fee_reviews
  ADD CONSTRAINT booking_group_cancellation_fee_reviews_payment_status_check
    CHECK (payment_status IN (
      'not_authorized', 'dispatch_blocked', 'dispatching',
      'pending_provider', 'unknown', 'succeeded', 'failed'
    )) NOT VALID,
  ADD CONSTRAINT booking_group_cancel_fee_review_decision_check
    CHECK (
      (state = 'pending_review' AND approval_request_id IS NULL
        AND decided_by_user_id IS NULL AND decided_by_role IS NULL
        AND decided_at IS NULL AND payment_status = 'not_authorized'
        AND amount_cents > 0)
      OR (state = 'approved_charge' AND approval_request_id IS NOT NULL
        AND decided_by_user_id IS NOT NULL AND decided_by_role IN ('owner', 'admin')
        AND decided_at IS NOT NULL
        AND payment_status IN ('dispatch_blocked', 'dispatching',
          'pending_provider', 'unknown', 'succeeded', 'failed')
        AND amount_cents > 0)
      OR (state = 'waived'
        AND decided_by_user_id IS NOT NULL AND decided_by_role IN ('owner', 'admin')
        AND decided_at IS NOT NULL AND payment_status = 'not_authorized'
        AND amount_cents > 0)
      OR (state = 'not_applicable' AND approval_request_id IS NULL
        AND decided_by_user_id IS NULL AND decided_by_role IS NULL
        AND decided_at IS NULL AND payment_status = 'not_authorized'
        AND amount_cents = 0)
    ) NOT VALID;

-- Existing approvals predate the column but are bound to exactly one immutable
-- receipt. Backfill from that receipt before validating the stricter checks.
UPDATE public.booking_group_cancellation_fee_reviews r
SET approval_request_id = a.approval_request_id
FROM public.booking_group_cancellation_fee_approval_receipts a
WHERE a.review_id = r.id
  AND r.approval_request_id IS NULL;

ALTER TABLE public.booking_group_cancellation_fee_reviews
  VALIDATE CONSTRAINT booking_group_cancellation_fee_reviews_payment_status_check;
ALTER TABLE public.booking_group_cancellation_fee_reviews
  VALIDATE CONSTRAINT booking_group_cancel_fee_review_decision_check;

CREATE UNIQUE INDEX booking_group_cancellation_fee_operation_once
  ON public.booking_group_cancellation_fee_reviews(payment_operation_id)
  WHERE payment_operation_id IS NOT NULL;

REVOKE INSERT, UPDATE, DELETE
  ON TABLE public.booking_group_cancellation_fee_reviews FROM service_role;
REVOKE INSERT, UPDATE, DELETE
  ON TABLE public.booking_group_cancellation_fee_approval_receipts FROM service_role;

-- Replace only the decision function so exact approval_request_id is copied to
-- the review row. Cancellation and approval still cannot call a provider.
CREATE OR REPLACE FUNCTION public.decide_group_cancellation_fee_review(
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
AS $decide_group$
DECLARE
  v_member_role text;
  v_review public.booking_group_cancellation_fee_reviews%ROWTYPE;
  v_existing public.booking_group_cancellation_fee_approval_receipts%ROWTYPE;
  v_fingerprint text;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_review_id IS NULL OR p_salon_id IS NULL OR p_actor_user_id IS NULL
     OR p_approval_request_id IS NULL OR p_action NOT IN ('charge', 'waive')
     OR p_actor_role NOT IN ('owner', 'admin') THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_request');
  END IF;
  SELECT m.role INTO v_member_role
  FROM public.salon_members m
  WHERE m.salon_id = p_salon_id AND m.user_id = p_actor_user_id
    AND m.role IN ('owner', 'admin') LIMIT 1;
  IF v_member_role IS NULL OR v_member_role IS DISTINCT FROM p_actor_role THEN
    RETURN jsonb_build_object('success', false, 'code', 'actor_unauthorized');
  END IF;
  SELECT * INTO v_existing
  FROM public.booking_group_cancellation_fee_approval_receipts r
  WHERE r.salon_id = p_salon_id
    AND r.approval_request_id = p_approval_request_id;
  IF FOUND THEN
    IF v_existing.review_id IS DISTINCT FROM p_review_id
       OR v_existing.action IS DISTINCT FROM p_action
       OR v_existing.actor_user_id IS DISTINCT FROM p_actor_user_id THEN
      RETURN jsonb_build_object('success', false, 'code', 'idempotency_mismatch');
    END IF;
    RETURN jsonb_build_object(
      'success', true, 'code', 'decision_replayed', 'review_id', p_review_id,
      'state', CASE WHEN p_action = 'charge' THEN 'approved_charge' ELSE 'waived' END,
      'payment_status', CASE WHEN p_action = 'charge'
        THEN 'dispatch_blocked' ELSE 'not_authorized' END
    );
  END IF;
  SELECT * INTO v_review
  FROM public.booking_group_cancellation_fee_reviews r
  WHERE r.id = p_review_id AND r.salon_id = p_salon_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'review_not_found');
  END IF;
  IF v_review.state <> 'pending_review' THEN
    RETURN jsonb_build_object('success', false, 'code', 'review_not_pending');
  END IF;
  v_fingerprint := encode(extensions.digest(convert_to(concat_ws('|',
    v_review.id::text, p_action, p_actor_user_id::text,
    v_review.amount_cents::text, v_review.currency,
    coalesce(v_review.consent_policy_version, ''), p_approval_request_id::text
  ), 'UTF8'), 'sha256'), 'hex');
  INSERT INTO public.booking_group_cancellation_fee_approval_receipts (
    salon_id, review_id, approval_request_id, action, actor_user_id, actor_role,
    amount_cents, currency, consent_policy_version, receipt_fingerprint
  ) VALUES (
    p_salon_id, p_review_id, p_approval_request_id, p_action,
    p_actor_user_id, v_member_role, v_review.amount_cents, v_review.currency,
    v_review.consent_policy_version, v_fingerprint
  );
  UPDATE public.booking_group_cancellation_fee_reviews
  SET state = CASE WHEN p_action = 'charge' THEN 'approved_charge' ELSE 'waived' END,
      approval_request_id = p_approval_request_id,
      decided_by_user_id = p_actor_user_id,
      decided_by_role = v_member_role,
      decided_at = transaction_timestamp(),
      payment_status = CASE WHEN p_action = 'charge'
        THEN 'dispatch_blocked' ELSE 'not_authorized' END,
      updated_at = transaction_timestamp()
  WHERE id = p_review_id;
  RETURN jsonb_build_object(
    'success', true, 'code', 'decision_recorded', 'review_id', p_review_id,
    'state', CASE WHEN p_action = 'charge' THEN 'approved_charge' ELSE 'waived' END,
    'payment_status', CASE WHEN p_action = 'charge'
      THEN 'dispatch_blocked' ELSE 'not_authorized' END
  );
END;
$decide_group$;

REVOKE ALL ON FUNCTION public.decide_group_cancellation_fee_review(
  uuid, uuid, uuid, text, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decide_group_cancellation_fee_review(
  uuid, uuid, uuid, text, uuid, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.preview_booking_group_cancellation_for_desk(
  p_salon_id uuid,
  p_group_id uuid,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $preview_group$
DECLARE
  v_actor_role text;
  v_salon public.salons%ROWTYPE;
  v_organizer public.bookings%ROWTYPE;
  v_group_size integer;
  v_earliest_start timestamptz;
  v_booked_value_cents integer;
  v_window_hours integer;
  v_notice_minutes integer;
  v_short_notice boolean;
  v_grace_ends_at timestamptz;
  v_grace_active boolean;
  v_within_window boolean;
  v_has_card boolean;
  v_no_show_fee integer;
  v_no_show_percent integer;
  v_late_percent integer;
  v_fee_cents integer;
  v_policy_version text;
  v_reason text;
BEGIN
  IF NOT public.staff_action_notification_caller_is_service_role() THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_group_id IS NULL OR p_actor_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_request');
  END IF;
  SELECT m.role INTO v_actor_role
  FROM public.salon_members m
  WHERE m.salon_id = p_salon_id AND m.user_id = p_actor_user_id
    AND m.role IN ('owner', 'admin', 'senior', 'receptionist')
  LIMIT 1;
  IF v_actor_role IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'actor_unauthorized');
  END IF;
  SELECT * INTO v_salon FROM public.salons s WHERE s.id = p_salon_id;
  SELECT * INTO v_organizer
  FROM public.bookings b
  WHERE b.salon_id = p_salon_id AND b.group_id = p_group_id
    AND b.is_group_organizer IS TRUE AND b.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'group_not_found');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.salon_id = p_salon_id AND b.group_id = p_group_id
      AND b.is_group_organizer IS TRUE AND b.id <> v_organizer.id
      AND b.deleted_at IS NULL
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'group_organizer_ambiguous');
  END IF;
  SELECT count(*)::integer,
    min(b.start_time_utc),
    coalesce(sum(coalesce(b.price_cents, 0) + coalesce(b.addon_price_cents, 0)), 0)::integer
  INTO v_group_size, v_earliest_start, v_booked_value_cents
  FROM public.bookings b
  WHERE b.salon_id = p_salon_id AND b.group_id = p_group_id
    AND b.deleted_at IS NULL
    AND b.status IN ('pending', 'confirmed', 'in_progress');
  IF v_group_size < 1 OR v_earliest_start IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'group_not_cancellable');
  END IF;

  v_window_hours := CASE
    WHEN coalesce(v_salon.self_cancel_window_hours, 0) > 0
      THEN v_salon.self_cancel_window_hours
    ELSE 24
  END;
  v_notice_minutes := floor(extract(epoch FROM (
    v_earliest_start - clock_timestamp()
  )) / 60)::integer;
  v_short_notice := v_earliest_start > v_organizer.created_at
    AND v_earliest_start <= v_organizer.created_at
      + make_interval(hours => v_window_hours);
  v_grace_ends_at := CASE WHEN v_short_notice
    THEN v_organizer.created_at + interval '15 minutes'
    ELSE NULL
  END;
  v_grace_active := v_grace_ends_at IS NOT NULL
    AND clock_timestamp() <= v_grace_ends_at;
  v_within_window := v_notice_minutes > 0
    AND v_notice_minutes < v_window_hours * 60
    AND NOT v_grace_active;
  v_no_show_fee := greatest(coalesce(v_organizer.noshow_fee_cents, 0), 0);
  v_no_show_percent := greatest(coalesce(v_salon.noshow_fee_percent, 0), 0);
  v_late_percent := least(20, greatest(0, coalesce(
    v_salon.self_cancel_fee_percent, v_salon.noshow_fee_percent, 0
  )));
  v_fee_cents := CASE WHEN v_no_show_percent > 0
    THEN round(v_no_show_fee::numeric * v_late_percent::numeric
      / v_no_show_percent::numeric)::integer
    ELSE 0
  END;
  v_policy_version := nullif(trim(coalesce(
    v_organizer.noshow_consent_meta->>'policyVersion', ''
  )), '');
  v_has_card := nullif(trim(coalesce(v_organizer.noshow_card_id, '')), '') IS NOT NULL
    AND nullif(trim(coalesce(v_organizer.noshow_customer_id, '')), '') IS NOT NULL
    AND v_organizer.noshow_consent_at IS NOT NULL
    AND v_policy_version IS NOT NULL
    AND v_fee_cents > 0
    AND coalesce(v_organizer.noshow_charge_status, '') <> 'charged';
  v_reason := CASE
    WHEN coalesce(v_salon.self_cancel_fee_enabled, false) IS NOT TRUE
      THEN 'policy_disabled'
    WHEN v_notice_minutes <= 0 THEN 'appointment_started'
    WHEN v_grace_active THEN 'short_notice_grace_active'
    WHEN NOT v_within_window THEN 'outside_fee_window'
    WHEN v_fee_cents <= 0 THEN 'fee_snapshot_missing'
    WHEN NOT v_has_card THEN 'card_or_consent_missing'
    ELSE 'owner_review_required'
  END;

  RETURN jsonb_build_object(
    'success', true,
    'code', 'preview_ready',
    'salon_id', p_salon_id,
    'group_id', p_group_id,
    'organizer_booking_id', v_organizer.id,
    'actor_role', v_actor_role,
    'group_size', v_group_size,
    'earliest_start_time_utc', v_earliest_start,
    'notice_minutes', v_notice_minutes,
    'window_hours', v_window_hours,
    'short_notice_booking', v_short_notice,
    'grace_active', v_grace_active,
    'grace_ends_at', v_grace_ends_at,
    'booked_value_cents', v_booked_value_cents,
    'fee_cents', CASE WHEN v_reason = 'owner_review_required'
      THEN v_fee_cents ELSE 0 END,
    'fee_snapshot_cents', v_fee_cents,
    'fee_percent', v_late_percent,
    'max_fee_percent', 20,
    'currency', upper(coalesce(nullif(trim(v_salon.currency_code), ''), 'CAD')),
    'has_chargeable_card', v_has_card,
    'decision_required', v_reason = 'owner_review_required',
    'can_waive', v_actor_role IN ('owner', 'admin'),
    'reason', v_reason,
    'consent_policy_version', v_policy_version,
    'card_brand', nullif(trim(coalesce(v_organizer.noshow_card_brand, '')), ''),
    'card_last4', nullif(trim(coalesce(v_organizer.noshow_card_last4, '')), '')
  );
END;
$preview_group$;

REVOKE ALL ON FUNCTION public.preview_booking_group_cancellation_for_desk(
  uuid, uuid, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.preview_booking_group_cancellation_for_desk(
  uuid, uuid, uuid
) TO service_role;
