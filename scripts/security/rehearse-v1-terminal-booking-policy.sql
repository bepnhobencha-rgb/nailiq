\set ON_ERROR_STOP on

BEGIN;
SELECT set_config('request.jwt.claim.role', 'service_role', true);

INSERT INTO public.service_categories(slug, name_en, name_vi)
VALUES ('v1-terminal-policy-qa', 'V1 terminal policy QA', 'V1 terminal policy QA');

INSERT INTO public.salons(id, slug, name, phone, timezone, currency_code)
VALUES (
  'fa470000-0000-4000-8000-000000000001',
  'v1-terminal-policy-qa',
  'V1 terminal policy QA',
  '+16045550470',
  'UTC',
  'CAD'
);

INSERT INTO public.services(id, salon_id, name, price_cents, duration_minutes, category)
VALUES (
  'fa470000-0000-4000-8000-000000000002',
  'fa470000-0000-4000-8000-000000000001',
  'V1 terminal policy service',
  4700,
  30,
  'v1-terminal-policy-qa'
);

INSERT INTO public.staff(id, salon_id, name, status, deleted_at)
VALUES (
  'fa470000-0000-4000-8000-000000000003',
  'fa470000-0000-4000-8000-000000000001',
  'V1 terminal policy staff',
  'active',
  NULL
);

INSERT INTO auth.users(
  id, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at
)
VALUES (
  'fa470000-0000-4000-8000-000000000004',
  'v1-terminal-policy@nailiq.invalid',
  '',
  transaction_timestamp(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  transaction_timestamp()
);

INSERT INTO public.salon_members(salon_id, user_id, role)
VALUES (
  'fa470000-0000-4000-8000-000000000001',
  'fa470000-0000-4000-8000-000000000004',
  'owner'
);

INSERT INTO public.bookings(
  id, salon_id, service_id, staff_id, client_name, client_phone, client_email,
  start_time_utc, end_time_utc, status, price_cents
)
VALUES
  (
    'fa470000-0000-4000-8000-000000000010',
    'fa470000-0000-4000-8000-000000000001',
    'fa470000-0000-4000-8000-000000000002',
    'fa470000-0000-4000-8000-000000000003',
    'Atomic cancel QA',
    '+16045550471',
    'atomic-cancel-qa@nailiq.invalid',
    transaction_timestamp() + interval '2 days',
    transaction_timestamp() + interval '2 days 30 minutes',
    'confirmed',
    4700
  ),
  (
    'fa470000-0000-4000-8000-000000000011',
    'fa470000-0000-4000-8000-000000000001',
    'fa470000-0000-4000-8000-000000000002',
    'fa470000-0000-4000-8000-000000000003',
    'Expired undo QA',
    '+16045550472',
    'expired-undo-qa@nailiq.invalid',
    transaction_timestamp() + interval '2 days 1 hour',
    transaction_timestamp() + interval '2 days 1 hour 30 minutes',
    'confirmed',
    4700
  ),
  (
    'fa470000-0000-4000-8000-000000000012',
    'fa470000-0000-4000-8000-000000000001',
    'fa470000-0000-4000-8000-000000000002',
    'fa470000-0000-4000-8000-000000000003',
    'No show QA',
    '+16045550473',
    'no-show-qa@nailiq.invalid',
    transaction_timestamp() + interval '2 days 2 hours',
    transaction_timestamp() + interval '2 days 2 hours 30 minutes',
    'confirmed',
    4700
  ),
  (
    'fa470000-0000-4000-8000-000000000013',
    'fa470000-0000-4000-8000-000000000001',
    'fa470000-0000-4000-8000-000000000002',
    'fa470000-0000-4000-8000-000000000003',
    'Recovery source QA',
    '+16045550474',
    'recovery-source-qa@nailiq.invalid',
    transaction_timestamp() + interval '2 days 3 hours',
    transaction_timestamp() + interval '2 days 3 hours 30 minutes',
    'cancelled',
    4700
  ),
  (
    'fa470000-0000-4000-8000-000000000014',
    'fa470000-0000-4000-8000-000000000001',
    'fa470000-0000-4000-8000-000000000002',
    'fa470000-0000-4000-8000-000000000003',
    'Recovery target QA',
    '+16045550475',
    'recovery-target-qa@nailiq.invalid',
    transaction_timestamp() + interval '2 days 4 hours',
    transaction_timestamp() + interval '2 days 4 hours 30 minutes',
    'confirmed',
    4700
  ),
  (
    'fa470000-0000-4000-8000-000000000015',
    'fa470000-0000-4000-8000-000000000001',
    'fa470000-0000-4000-8000-000000000002',
    'fa470000-0000-4000-8000-000000000003',
    'Legacy rollout QA',
    '+16045550476',
    'legacy-rollout-qa@nailiq.invalid',
    transaction_timestamp() + interval '2 days 5 hours',
    transaction_timestamp() + interval '2 days 5 hours 30 minutes',
    'confirmed',
    4700
  );

CREATE OR REPLACE FUNCTION public.mqa_reject_terminal_audit_for_rehearsal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  IF new.event_type = 'terminal_booking_transition_authorized' THEN
    RAISE EXCEPTION 'intentional terminal audit failure';
  END IF;
  RETURN new;
END
$function$;

CREATE TRIGGER mqa_reject_terminal_audit_for_rehearsal_trigger
BEFORE INSERT ON public.booking_events
FOR EACH ROW
EXECUTE FUNCTION public.mqa_reject_terminal_audit_for_rehearsal();

DO $rehearsal$
DECLARE
  v_salon uuid := 'fa470000-0000-4000-8000-000000000001';
  v_actor uuid := 'fa470000-0000-4000-8000-000000000004';
  v_booking uuid := 'fa470000-0000-4000-8000-000000000010';
  v_result jsonb;
BEGIN
  BEGIN
    v_result := public.transition_booking_to_terminal_v1(
      v_booking, v_salon, v_actor, 'owner', 'desk_cancel'
    );
    RAISE EXCEPTION 'terminal transition unexpectedly survived audit failure: %', v_result;
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'intentional terminal audit failure' THEN
        RAISE;
      END IF;
  END;

  IF (SELECT status FROM public.bookings WHERE id = v_booking) <> 'confirmed' THEN
    RAISE EXCEPTION 'booking update did not roll back with audit failure';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.booking_events
     WHERE booking_id = v_booking
       AND event_type = 'terminal_booking_transition_authorized'
  ) THEN
    RAISE EXCEPTION 'audit row survived its failed transaction';
  END IF;
END
$rehearsal$;

DROP TRIGGER mqa_reject_terminal_audit_for_rehearsal_trigger
  ON public.booking_events;
DROP FUNCTION public.mqa_reject_terminal_audit_for_rehearsal();

DO $rehearsal$
DECLARE
  v_salon uuid := 'fa470000-0000-4000-8000-000000000001';
  v_actor uuid := 'fa470000-0000-4000-8000-000000000004';
  v_booking uuid := 'fa470000-0000-4000-8000-000000000010';
  v_expired uuid := 'fa470000-0000-4000-8000-000000000011';
  v_cancel_request uuid := 'fa470000-0000-4000-8000-000000000101';
  v_expired_request uuid := 'fa470000-0000-4000-8000-000000000102';
  v_no_show uuid := 'fa470000-0000-4000-8000-000000000012';
  v_source uuid := 'fa470000-0000-4000-8000-000000000013';
  v_target uuid := 'fa470000-0000-4000-8000-000000000014';
  v_legacy uuid := 'fa470000-0000-4000-8000-000000000015';
  v_result jsonb;
  v_cancel_lease jsonb;
BEGIN
  v_result := public.transition_desk_booking_cancel_with_deferred_owner_v1(
    v_booking, v_salon, v_actor, 'owner',
    v_cancel_request, false, true, 20
  );
  IF v_result->>'code' <> 'transitioned'
     OR v_result->>'owner_cancel_notification_deferred' <> 'true'
     OR (SELECT status FROM public.bookings WHERE id = v_booking) <> 'cancelled' THEN
    RAISE EXCEPTION 'atomic cancel failed: %', v_result;
  END IF;
  IF (
    SELECT count(*) FROM public.booking_events
     WHERE booking_id = v_booking
       AND event_type = 'terminal_booking_transition_authorized'
       AND actor_user_id = v_actor
       AND actor_role = 'owner'
       AND payload @> '{"from":"confirmed","to":"cancelled","reason":"desk_cancel","source":"v1_terminal_booking_policy"}'::jsonb
  ) <> 1 THEN
    RAISE EXCEPTION 'canonical cancel audit missing or duplicated';
  END IF;
  IF (
    SELECT count(*) FROM public.owner_booking_notification_outbox
     WHERE booking_id = v_booking
       AND event_type = 'cancel'
       AND status = 'pending'
       AND next_attempt_at >= created_at + interval '19 seconds'
       AND provider_receipt_count = 0
  ) <> 1 THEN
    RAISE EXCEPTION 'desk cancel owner email was not durably delayed';
  END IF;
  IF (
    SELECT count(*) FROM public.staff_action_notification_outbox
     WHERE booking_id = v_booking
       AND event_type = 'cancel'
       AND request_id = v_cancel_request
       AND status = 'active'
       AND notification_delay_seconds = 20
       AND send_after >= created_at + interval '19 seconds'
  ) <> 1 THEN
    RAISE EXCEPTION 'desk cancel customer email was not durably delayed';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.claim_owner_booking_notification_outbox_batch(25) AS leased
     WHERE leased->>'booking_id' = v_booking::text
       AND leased->>'event_type' = 'cancel'
  ) THEN
    RAISE EXCEPTION 'desk cancel owner email leased inside undo window';
  END IF;

  v_result := public.undo_recent_cancelled_booking_v1(
    v_booking, v_salon, v_actor, 'owner'
  );
  IF v_result->>'code' <> 'cancel_undone'
     OR (SELECT status FROM public.bookings WHERE id = v_booking) <> 'confirmed' THEN
    RAISE EXCEPTION 'immediate undo failed: %', v_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.booking_events
     WHERE booking_id = v_booking
       AND event_type = 'terminal_booking_transition_authorized'
       AND actor_user_id = v_actor
       AND payload @> '{"from":"cancelled","to":"confirmed","reason":"immediate_cancel_undo","source":"v1_terminal_booking_policy","correctionWindowSeconds":8}'::jsonb
  ) THEN
    RAISE EXCEPTION 'canonical immediate undo audit missing';
  END IF;
  IF (
    SELECT count(*) FROM public.owner_booking_notification_outbox
     WHERE booking_id = v_booking
       AND event_type = 'cancel'
       AND status = 'suppressed'
       AND last_error = 'booking_cancel_undone'
       AND provider_receipt_count = 0
  ) <> 1 THEN
    RAISE EXCEPTION 'undo did not atomically suppress owner cancellation email';
  END IF;
  IF (
    SELECT count(*) FROM public.staff_action_notification_outbox
     WHERE booking_id = v_booking
       AND event_type = 'cancel'
       AND request_id = v_cancel_request
       AND status = 'cancelled'
       AND cancellation_reason = 'booking_cancel_undone'
  ) <> 1 THEN
    RAISE EXCEPTION 'undo did not atomically suppress customer cancellation notification';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.staff_action_notification_deliveries d
      JOIN public.staff_action_notification_outbox o ON o.id = d.outbox_id
     WHERE o.booking_id = v_booking
       AND o.event_type = 'cancel'
       AND o.request_id = v_cancel_request
       AND (
         d.status <> 'cancelled'
         OR d.provider_message_id IS NOT NULL
         OR COALESCE(d.error_code, '') <> 'booking_cancel_undone'
         OR COALESCE(d.reconciliation_reason, '') <> 'booking_cancel_undone'
       )
  ) THEN
    RAISE EXCEPTION 'undo left a customer cancellation delivery sendable or provider-accepted';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.owner_booking_notification_claims
     WHERE booking_id = v_booking AND event_type = 'cancel'
  ) THEN
    RAISE EXCEPTION 'undoed cancellation created a recipient claim';
  END IF;

  v_result := public.undo_recent_cancelled_booking_v1(
    v_booking, v_salon, v_actor, 'owner'
  );
  IF v_result->>'code' <> 'undo_replay' OR v_result->>'idempotent' <> 'true' THEN
    RAISE EXCEPTION 'immediate undo replay was not idempotent: %', v_result;
  END IF;

  v_result := public.transition_desk_booking_cancel_with_deferred_owner_v1(
    v_expired, v_salon, v_actor, 'owner',
    v_expired_request, false, true, 20
  );
  IF v_result->>'code' <> 'transitioned'
     OR v_result->>'owner_cancel_notification_deferred' <> 'true' THEN
    RAISE EXCEPTION 'expired-window setup failed: %', v_result;
  END IF;
  UPDATE public.booking_events
     SET created_at = clock_timestamp() - interval '9 seconds'
   WHERE booking_id = v_expired
     AND event_type = 'terminal_booking_transition_authorized'
     AND payload->>'to' = 'cancelled';
  v_result := public.undo_recent_cancelled_booking_v1(
    v_expired, v_salon, v_actor, 'owner'
  );
  IF v_result->>'code' <> 'undo_window_expired'
     OR (SELECT status FROM public.bookings WHERE id = v_expired) <> 'cancelled' THEN
    RAISE EXCEPTION 'expired undo was not rejected: %', v_result;
  END IF;
  UPDATE public.owner_booking_notification_outbox
     SET next_attempt_at = clock_timestamp() - interval '1 second'
   WHERE booking_id = v_expired
     AND event_type = 'cancel'
     AND status = 'pending';
  SELECT leased INTO v_cancel_lease
    FROM public.claim_owner_booking_notification_outbox_batch(25) AS leased
   WHERE leased->>'booking_id' = v_expired::text
     AND leased->>'event_type' = 'cancel'
   LIMIT 1;
  IF v_cancel_lease IS NULL OR v_cancel_lease->>'code' <> 'leased' THEN
    RAISE EXCEPTION 'settled cancellation did not become claimable';
  END IF;

  -- Migration-first rollout compatibility: old application code still calls
  -- the legacy transition. Without the explicit handshake it must not queue a
  -- second owner email alongside that code's immediate notification.
  v_result := public.transition_booking_to_terminal_v1(
    v_legacy, v_salon, v_actor, 'owner', 'desk_cancel'
  );
  IF v_result->>'code' <> 'transitioned'
     OR (SELECT status FROM public.bookings WHERE id = v_legacy) <> 'cancelled'
     OR EXISTS (
       SELECT 1 FROM public.owner_booking_notification_outbox
        WHERE booking_id = v_legacy AND event_type = 'cancel'
     ) THEN
    RAISE EXCEPTION 'legacy rollout path created a duplicate delayed owner email: %', v_result;
  END IF;

  v_result := public.transition_booking_to_terminal_v1(
    v_no_show, v_salon, v_actor, 'owner', 'desk_no_show'
  );
  IF v_result->>'code' <> 'transitioned'
     OR (SELECT status FROM public.bookings WHERE id = v_no_show) <> 'no_show' THEN
    RAISE EXCEPTION 'no-show transition failed: %', v_result;
  END IF;

  BEGIN
    UPDATE public.bookings SET status = 'confirmed' WHERE id = v_no_show;
    RAISE EXCEPTION 'no-show restore unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.bookings SET client_name = 'Rewritten terminal client' WHERE id = v_expired;
    RAISE EXCEPTION 'terminal identity rewrite unexpectedly succeeded';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  UPDATE public.bookings
     SET noshow_charge_attempts = noshow_charge_attempts + 1
   WHERE id = v_no_show;
  IF (SELECT noshow_charge_attempts FROM public.bookings WHERE id = v_no_show) <> 1 THEN
    RAISE EXCEPTION 'dedicated no-show fee workflow field was blocked';
  END IF;

  BEGIN
    UPDATE public.bookings
       SET recovered_from_booking_id = v_source,
           recovery_kind = 'cancelled_rebook',
           recovered_by_user_id = v_actor
     WHERE id = v_target;
    RAISE EXCEPTION 'linked archived recovery unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  v_result := public.transition_booking_to_terminal_v1(
    v_target, v_salon, v_actor, 'admin', 'desk_cancel'
  );
  IF v_result->>'code' <> 'actor_unauthorized'
     OR (SELECT status FROM public.bookings WHERE id = v_target) <> 'confirmed' THEN
    RAISE EXCEPTION 'actor-role mismatch was not rejected: %', v_result;
  END IF;

  IF has_function_privilege(
       'authenticated',
       'public.transition_booking_to_terminal_v1(uuid,uuid,uuid,text,text,uuid,boolean,boolean,integer)',
       'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated',
       'public.undo_recent_cancelled_booking_v1(uuid,uuid,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'authenticated role retained direct RPC execute privilege';
  END IF;
END
$rehearsal$;

ROLLBACK;
