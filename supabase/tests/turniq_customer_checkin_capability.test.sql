BEGIN;

DO $test$
DECLARE
  v_salon constant uuid := '49000000-0000-4000-8000-000000000001';
  v_other_salon constant uuid := '49000000-0000-4000-8000-000000000002';
  v_owner constant uuid := '49000000-0000-4000-8000-000000000003';
  v_other_owner constant uuid := '49000000-0000-4000-8000-000000000004';
  v_service constant uuid := '49000000-0000-4000-8000-000000000005';
  v_booking constant uuid := '49000000-0000-4000-8000-000000000006';
  v_result jsonb;
  v_capability uuid;
  v_failed boolean := false;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (v_owner, 'turniq-m4n-owner@example.invalid'),
    (v_other_owner, 'turniq-m4n-other@example.invalid');
  INSERT INTO public.salons (id, slug, name, phone, timezone, feature_flags) VALUES
    (v_salon, 'turniq-m4n-synthetic', 'TurnIQ M4N Synthetic', '+16045550491',
      'America/Vancouver', '{"turniq_trust_engine_enabled":true}'::jsonb),
    (v_other_salon, 'turniq-m4n-other', 'TurnIQ M4N Other', '+16045550492',
      'America/Vancouver', '{"turniq_trust_engine_enabled":true}'::jsonb);
  INSERT INTO public.salon_members (salon_id, user_id, role) VALUES
    (v_salon, v_owner, 'owner'),
    (v_other_salon, v_other_owner, 'owner');
  INSERT INTO public.service_categories (slug, name_en, name_vi)
  VALUES ('other', 'Other', 'Khác')
  ON CONFLICT (slug) DO NOTHING;
  INSERT INTO public.services (
    id, salon_id, name, price_cents, duration_minutes, buffer_minutes
  ) VALUES (v_service, v_salon, 'Synthetic Classic', 5000, 30, 0);
  INSERT INTO public.bookings (
    id, salon_id, service_id, client_name, client_phone, start_time_utc,
    end_time_utc, status, price_cents, subtotal_cents, tax_amount_cents,
    party_size
  ) VALUES (
    v_booking, v_salon, v_service, 'Synthetic Customer', '+16045550493',
    transaction_timestamp() + interval '1 hour',
    transaction_timestamp() + interval '90 minutes', 'confirmed',
    5000, 5000, 0, 1
  );

  v_result := public.issue_turniq_customer_checkin_capability_v1(
    v_salon, v_booking, v_service, 'qr', 'booked', repeat('a', 64),
    clock_timestamp() + interval '2 hours', 1, v_owner
  );
  IF coalesce((v_result ->> 'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'capability issuance failed: %', v_result;
  END IF;
  v_capability := (v_result ->> 'capability_id')::uuid;

  v_result := public.revoke_turniq_customer_checkin_capability_v1(
    v_other_salon, v_capability, v_other_owner
  );
  IF v_result ->> 'code' <> 'not_found' THEN
    RAISE EXCEPTION 'cross-tenant revoke did not fail closed: %', v_result;
  END IF;

  v_result := public.revoke_turniq_customer_checkin_capability_v1(
    v_salon, v_capability, v_owner
  );
  IF coalesce((v_result ->> 'ok')::boolean, false) IS NOT TRUE
     OR coalesce((v_result ->> 'replayed')::boolean, true) IS TRUE THEN
    RAISE EXCEPTION 'first revoke mismatch: %', v_result;
  END IF;

  v_result := public.revoke_turniq_customer_checkin_capability_v1(
    v_salon, v_capability, v_owner
  );
  IF coalesce((v_result ->> 'ok')::boolean, false) IS NOT TRUE
     OR coalesce((v_result ->> 'replayed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'revoke retry was not idempotent: %', v_result;
  END IF;

  v_result := public.record_turniq_customer_checkin_shadow_v1(
    repeat('a', 64), 'qr', 'booked',
    '49000000-0000-4000-8000-000000000007', v_service, 1,
    clock_timestamp(), repeat('b', 64), NULL, repeat('c', 64)
  );
  IF v_result ->> 'code' <> 'capability_unavailable' THEN
    RAISE EXCEPTION 'revoked capability still recorded intake: %', v_result;
  END IF;

  BEGIN
    UPDATE public.turniq_customer_checkin_capabilities
    SET revoked_at = NULL, revoked_by_user_id = NULL
    WHERE id = v_capability;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'revoked capability was silently reopened';
  END IF;

  v_result := public.issue_turniq_customer_checkin_capability_v1(
    v_salon, v_booking, v_service, 'qr', 'booked', repeat('d', 64),
    clock_timestamp() + interval '2 hours', 1, v_owner
  );
  v_result := public.record_turniq_customer_checkin_shadow_v1(
    repeat('d', 64), 'qr', 'booked',
    '49000000-0000-4000-8000-000000000008', v_service, 1,
    clock_timestamp(), repeat('e', 64), NULL, repeat('f', 64)
  );
  IF coalesce((v_result ->> 'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'fresh receipt failed: %', v_result;
  END IF;
  v_result := public.record_turniq_customer_checkin_shadow_v1(
    repeat('d', 64), 'qr', 'booked',
    '49000000-0000-4000-8000-000000000008', v_service, 1,
    clock_timestamp() - interval '1 hour', repeat('e', 64), NULL, repeat('f', 64)
  );
  IF coalesce((v_result ->> 'replayed')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'old exact retry did not return committed receipt: %', v_result;
  END IF;

  IF has_function_privilege(
    'anon',
    'public.revoke_turniq_customer_checkin_capability_v1(uuid,uuid,uuid)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.revoke_turniq_customer_checkin_capability_v1(uuid,uuid,uuid)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.revoke_turniq_customer_checkin_capability_v1(uuid,uuid,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'revoke RPC ACL mismatch';
  END IF;
END
$test$;

ROLLBACK;
