\set ON_ERROR_STOP on

BEGIN;

DO $rehearsal$
DECLARE
  v_salon constant uuid := 'a1000000-0000-4000-8000-000000000001';
  v_service constant uuid := 'a1000000-0000-4000-8000-000000000002';
  v_addon constant uuid := 'a1000000-0000-4000-8000-000000000003';
  v_addon_two constant uuid := 'a1000000-0000-4000-8000-000000000009';
  v_addon_three constant uuid := 'a1000000-0000-4000-8000-000000000010';
  v_staff constant uuid := 'a1000000-0000-4000-8000-000000000004';
  v_promo constant uuid := 'a1000000-0000-4000-8000-000000000005';
  v_voucher constant uuid := 'a1000000-0000-4000-8000-000000000006';
  v_idem constant uuid := 'a1000000-0000-4000-8000-000000000007';
  v_changed_idem constant uuid := 'a1000000-0000-4000-8000-000000000008';
  v_multi_idem constant uuid := 'a1000000-0000-4000-8000-000000000011';
  v_deleted_staff constant uuid := 'a1000000-0000-4000-8000-000000000012';
  v_inactive_staff constant uuid := 'a1000000-0000-4000-8000-000000000013';
  v_start timestamptz := date_trunc('day', clock_timestamp()) + interval '2 days 12 hours';
  v_end timestamptz;
  v_quote jsonb;
  v_result jsonb;
  v_booking_id uuid;
  v_legacy_booking_id uuid;
  v_multi_booking_id uuid;
  v_multi_start timestamptz;
  v_multi_end timestamptz;
  v_claim jsonb;
  v_before_bookings bigint;
  v_before_profiles bigint;
  v_before_redemptions bigint;
  v_attempt integer;
BEGIN
  v_end := v_start + interval '40 minutes';
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  INSERT INTO public.service_categories (slug, name_en, name_vi)
  VALUES ('pricing-rehearsal', 'Pricing rehearsal', 'Pricing rehearsal');

  INSERT INTO public.salons (
    id, slug, name, phone, timezone, currency_code, opening_hours, tax_lines
  ) VALUES (
    v_salon,
    'pricing-rehearsal',
    'Pricing rehearsal',
    '+16045550100',
    'UTC',
    'CAD',
    '{
      "sun":{"open":"00:00","close":"23:59","closed":false},
      "mon":{"open":"00:00","close":"23:59","closed":false},
      "tue":{"open":"00:00","close":"23:59","closed":false},
      "wed":{"open":"00:00","close":"23:59","closed":false},
      "thu":{"open":"00:00","close":"23:59","closed":false},
      "fri":{"open":"00:00","close":"23:59","closed":false},
      "sat":{"open":"00:00","close":"23:59","closed":false}
    }'::jsonb,
    '[{"name":"GST","rate":0.05,"enabled":true}]'::jsonb
  );

  INSERT INTO public.services (
    id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
    category, is_addon, addon_timing
  ) VALUES
    (v_service, v_salon, 'Main service', 5000, 30, 10,
     'pricing-rehearsal', false, 'sequential'),
    (v_addon, v_salon, 'Concurrent add-on', 1000, 15, 5,
     'pricing-rehearsal', true, 'concurrent'),
    (v_addon_two, v_salon, 'Sequential add-on two', 700, 10, 5,
     'pricing-rehearsal', true, 'sequential'),
    (v_addon_three, v_salon, 'Sequential add-on three', 900, 20, 5,
     'pricing-rehearsal', true, 'sequential');

  INSERT INTO public.staff (id, salon_id, name, status, deleted_at)
  VALUES
    (v_staff, v_salon, 'Active staff', 'active', NULL),
    (v_deleted_staff, v_salon, 'Deleted active staff', 'active', clock_timestamp()),
    (v_inactive_staff, v_salon, 'Inactive staff', 'inactive', NULL);
  INSERT INTO public.staff_services (staff_id, service_id)
  VALUES
    (v_staff, v_service),
    (v_staff, v_addon),
    (v_staff, v_addon_two),
    (v_staff, v_addon_three);

  INSERT INTO public.promotions (
    id, salon_id, name, starts_at, ends_at,
    discount_type, discount_value, applies_to, active
  ) VALUES (
    v_promo, v_salon, 'Ten percent', clock_timestamp() - interval '1 day',
    clock_timestamp() + interval '10 days', 'percent', 1000, 'all', true
  );

  INSERT INTO public.vouchers (
    id, salon_id, code, kind, client_phone, amount_off_cents,
    max_uses, valid_from, expires_at
  ) VALUES (
    v_voucher, v_salon, 'REHEARSE300', 'promo', '16045550199', 300,
    5, clock_timestamp() - interval '1 day', clock_timestamp() + interval '10 days'
  );

  v_quote := public.quote_public_booking(
    v_salon, v_service, v_deleted_staff, v_start, v_end, ARRAY[]::uuid[],
    NULL, NULL, '+16045550120', NULL, false
  );
  IF v_quote->>'code' <> 'invalid_staff' THEN
    RAISE EXCEPTION 'soft-deleted active staff remained bookable: %', v_quote;
  END IF;

  v_quote := public.quote_public_booking(
    v_salon, v_service, v_staff, v_start, v_end, ARRAY[v_addon],
    NULL, v_voucher, '+1 (604) 555-0199', 'qa@example.test', true
  );

  IF v_quote->>'success' <> 'true'
     OR v_quote->>'code' <> 'quoted'
     OR (v_quote->>'original_price_cents')::integer <> 5000
     OR (v_quote->>'promo_discount_cents')::integer <> 500
     OR (v_quote->>'email_discount_cents')::integer <> 200
     OR (v_quote->>'voucher_discount_cents')::integer <> 300
     OR (v_quote->>'price_cents')::integer <> 4000
     OR (v_quote->>'addon_price_cents')::integer <> 1000
     OR (v_quote->>'subtotal_cents')::integer <> 5000
     OR (v_quote->>'tax_cents')::integer <> 250
     OR (v_quote->>'total_cents')::integer <> 5250
     OR (v_quote->>'trailing_buffer_minutes')::integer <> 10
     OR v_quote->>'pricing_fingerprint' !~ '^[0-9a-f]{64}$'
     OR v_quote->'tax_breakdown'->0->>'name' <> 'GST' THEN
    RAISE EXCEPTION 'authoritative quote mismatch: %', v_quote;
  END IF;

  v_result := public.create_public_booking(
    v_salon, v_service, v_staff, 'QA Guest', '+1 (604) 555-0199',
    v_start, v_end, 'confirmed', 'rehearsal', ARRAY[v_addon],
    'qa@example.test', NULL, NULL, v_voucher, true, v_idem,
    v_quote->>'pricing_fingerprint'
  );
  IF v_result->>'success' <> 'true'
     OR v_result->>'code' <> 'booked'
     OR (v_result->>'idempotent')::boolean THEN
    RAISE EXCEPTION 'create failed: %', v_result;
  END IF;
  v_booking_id := (v_result->>'booking_id')::uuid;

  IF NOT EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.id = v_booking_id
      AND b.status = 'confirmed'
      AND b.price_cents = 4000
      AND b.addon_price_cents = 1000
      AND b.subtotal_cents = 5000
      AND b.tax_amount_cents = 250
      AND b.promo_id = v_promo
      AND b.public_booking_pricing_fingerprint = v_quote->>'pricing_fingerprint'
      AND b.public_booking_pricing_snapshot = v_quote
  ) OR (SELECT count(*) FROM public.booking_addons ba
        WHERE ba.booking_id = v_booking_id AND ba.service_id = v_addon) <> 1
     OR (SELECT count(*) FROM public.voucher_redemptions vr
         WHERE vr.voucher_id = v_voucher AND vr.booking_id = v_booking_id) <> 1
     OR (SELECT used_count FROM public.vouchers WHERE id = v_voucher) <> 1
     OR (SELECT visit_count FROM public.client_profiles WHERE phone = '16045550199') <> 1
     OR (SELECT email_discount_claimed_at FROM public.client_profiles
         WHERE phone = '16045550199') IS NULL THEN
    RAISE EXCEPTION 'atomic booking persistence mismatch';
  END IF;

  v_result := public.create_public_booking(
    v_salon, v_service, v_staff, 'QA Guest', '+1 (604) 555-0199',
    v_start, v_end, 'confirmed', 'rehearsal', ARRAY[v_addon],
    'qa@example.test', NULL, NULL, v_voucher, true, v_idem,
    v_quote->>'pricing_fingerprint'
  );
  IF v_result->>'success' <> 'true'
     OR NOT (v_result->>'idempotent')::boolean
     OR (SELECT count(*) FROM public.bookings WHERE salon_id = v_salon) <> 1
     OR (SELECT visit_count FROM public.client_profiles WHERE phone = '16045550199') <> 1
     OR (SELECT used_count FROM public.vouchers WHERE id = v_voucher) <> 1 THEN
    RAISE EXCEPTION 'idempotent replay mismatch: %', v_result;
  END IF;

  v_result := public.create_public_booking(
    v_salon, v_service, v_staff, 'QA Guest', '+1 (604) 555-0199',
    v_start, v_end, 'confirmed', 'changed payload', ARRAY[v_addon],
    'qa@example.test', NULL, NULL, v_voucher, true, v_idem,
    v_quote->>'pricing_fingerprint'
  );
  IF v_result->>'code' <> 'idempotency_conflict' THEN
    RAISE EXCEPTION 'payload-bound replay was not enforced: %', v_result;
  END IF;

  -- Receptionist normal-hours bookings use this same service-role quote/create
  -- contract with the complete add-on array. Two sequential add-ons must remain
  -- atomic and preserve the full main + buffer + add-on block (40 + 15 + 25).
  v_multi_start := v_start + interval '8 hours';
  v_multi_end := v_multi_start + interval '80 minutes';
  v_quote := public.quote_public_booking(
    v_salon, v_service, v_staff, v_multi_start, v_multi_end,
    ARRAY[v_addon_two, v_addon_three], NULL, NULL,
    '+16045550144', 'desk@example.test', false
  );
  IF v_quote->>'success' <> 'true'
     OR (v_quote->>'end_time_utc')::timestamptz <> v_multi_end
     OR pg_catalog.jsonb_array_length(v_quote->'addon_lines') <> 2 THEN
    RAISE EXCEPTION 'multi-sequential quote mismatch: %', v_quote;
  END IF;
  v_result := public.create_public_booking(
    v_salon, v_service, v_staff, 'Desk Multi Add-on', '+16045550144',
    v_multi_start, v_multi_end, 'confirmed', 'receptionist rehearsal',
    ARRAY[v_addon_two, v_addon_three], 'desk@example.test', NULL,
    NULL, NULL, false, v_multi_idem, v_quote->>'pricing_fingerprint'
  );
  IF v_result->>'success' <> 'true' THEN
    RAISE EXCEPTION 'multi-sequential create mismatch: %', v_result;
  END IF;
  v_multi_booking_id := (v_result->>'booking_id')::uuid;
  IF (SELECT b.end_time_utc FROM public.bookings b
      WHERE b.id = v_multi_booking_id) <> v_multi_end
     OR (SELECT count(*) FROM public.booking_addons ba
         WHERE ba.booking_id = v_multi_booking_id
           AND ba.service_id IN (v_addon_two, v_addon_three)) <> 2 THEN
    RAISE EXCEPTION 'multi-sequential stored block or add-ons mismatch';
  END IF;

  SELECT count(*) INTO v_before_bookings FROM public.bookings WHERE salon_id = v_salon;
  SELECT count(*) INTO v_before_profiles FROM public.client_profiles WHERE phone = '16045550199';
  SELECT count(*) INTO v_before_redemptions FROM public.voucher_redemptions WHERE salon_id = v_salon;
  UPDATE public.services SET price_cents = 6000 WHERE id = v_service;

  v_result := public.create_public_booking(
    v_salon, v_service, v_staff, 'QA Guest', '+1 (604) 555-0199',
    v_start + interval '2 hours', v_end + interval '2 hours', 'confirmed',
    'pricing changed', ARRAY[v_addon], 'qa@example.test', NULL, NULL,
    v_voucher, true, v_changed_idem, v_quote->>'pricing_fingerprint'
  );
  IF v_result->>'success' <> 'false'
     OR v_result->>'code' <> 'pricing_changed'
     OR v_result->'quote'->>'pricing_fingerprint' = v_quote->>'pricing_fingerprint'
     OR (SELECT count(*) FROM public.bookings WHERE salon_id = v_salon) <> v_before_bookings
     OR (SELECT count(*) FROM public.client_profiles WHERE phone = '16045550199') <> v_before_profiles
     OR (SELECT count(*) FROM public.voucher_redemptions WHERE salon_id = v_salon) <> v_before_redemptions
     OR (SELECT used_count FROM public.vouchers WHERE id = v_voucher) <> 1 THEN
    RAISE EXCEPTION 'pricing_changed did not remain zero-write: %', v_result;
  END IF;

  v_result := public.create_public_booking(
    v_salon, v_service, v_staff, 'QA Guest', '+1 (604) 555-0199',
    v_start + interval '3 hours', v_end + interval '3 hours', 'pending', NULL,
    ARRAY[]::uuid[], NULL, NULL, NULL, NULL, false,
    gen_random_uuid(), repeat('0', 64)
  );
  IF v_result->>'code' <> 'invalid_status' THEN
    RAISE EXCEPTION 'confirmed-only boundary mismatch: %', v_result;
  END IF;

  -- A fake fingerprint may consume only the dedicated abuse ledger. It must not
  -- run the resolver or disclose a fresh quote once the phone budget is spent,
  -- and it must never create business rows.
  SELECT count(*) INTO v_before_bookings FROM public.bookings WHERE salon_id = v_salon;
  SELECT count(*) INTO v_before_profiles FROM public.client_profiles WHERE phone = '16045550155';
  SELECT count(*) INTO v_before_redemptions FROM public.voucher_redemptions WHERE salon_id = v_salon;
  PERFORM set_config('request.jwt.claim.role', 'anon', true);
  FOR v_attempt IN 1..31 LOOP
    v_result := public.create_public_booking(
      v_salon, v_service, v_staff, 'Abuse Gate QA', '+16045550155',
      v_start + interval '7 hours', v_end + interval '7 hours',
      'confirmed', 'fake fingerprint', ARRAY[]::uuid[], NULL, NULL,
      NULL, NULL, false, extensions.gen_random_uuid(), repeat('0', 64)
    );
    IF v_attempt <= 30 AND v_result->>'code' <> 'pricing_changed' THEN
      RAISE EXCEPTION 'abuse gate rejected within budget at %: %', v_attempt, v_result;
    ELSIF v_attempt = 31 AND (
      v_result->>'code' <> 'rate_limited' OR v_result ? 'quote'
    ) THEN
      RAISE EXCEPTION 'abuse gate did not fail closed: %', v_result;
    END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  IF (SELECT count(*) FROM public.bookings WHERE salon_id = v_salon) <> v_before_bookings
     OR (SELECT count(*) FROM public.client_profiles WHERE phone = '16045550155') <> v_before_profiles
     OR (SELECT count(*) FROM public.voucher_redemptions WHERE salon_id = v_salon) <> v_before_redemptions
     OR NOT EXISTS (
       SELECT 1 FROM public.rate_limits rl
       WHERE rl.bucket LIKE
         'public-booking-pricing-attempt:phone:' ||
         pg_catalog.md5(v_salon::text || ':16045550155') || ':%'
         AND rl.count = 31
     ) THEN
    RAISE EXCEPTION 'abuse gate business-write or ledger mismatch';
  END IF;

  -- Phase A deliberately keeps the deployed 14-argument overload callable.
  -- Exercise it after hardening its search_path so rollout compatibility is
  -- proven rather than inferred from the ACL alone.
  v_result := public.create_public_booking(
    v_salon, v_service, v_staff, 'Legacy QA Guest', '+16045550177',
    v_start + interval '6 hours',
    v_start + interval '6 hours 30 minutes',
    'confirmed', 1234, 'phase A compatibility', NULL, NULL, NULL, NULL
  );
  IF v_result->>'success' <> 'true'
     OR (v_result->>'end_time_utc')::timestamptz <>
       v_end + interval '6 hours' THEN
    RAISE EXCEPTION 'legacy phase-A compatibility failed: %', v_result;
  END IF;
  v_legacy_booking_id := (v_result->>'booking_id')::uuid;
  IF (SELECT b.price_cents FROM public.bookings b
      WHERE b.id = v_legacy_booking_id) <> 5400 THEN
    RAISE EXCEPTION 'legacy caller money was trusted: %', v_result;
  END IF;

  DELETE FROM public.staff_services WHERE staff_id = v_staff AND service_id = v_addon;
  v_result := public.create_public_booking(
    v_salon, v_service, v_staff, 'Legacy Capability QA', '+16045550166',
    v_start + interval '4 hours', v_end + interval '4 hours',
    'confirmed', 1, NULL, v_addon, 1, NULL, NULL
  );
  IF v_result->>'code' <> 'invalid_staff_capability' THEN
    RAISE EXCEPTION 'legacy staff capability mismatch: %', v_result;
  END IF;
  v_result := public.quote_public_booking(
    v_salon, v_service, v_staff, v_start + interval '4 hours',
    v_end + interval '4 hours', ARRAY[v_addon], NULL, NULL,
    '+16045550188', NULL, false
  );
  IF v_result->>'code' <> 'invalid_staff_capability' THEN
    RAISE EXCEPTION 'staff add-on capability mismatch: %', v_result;
  END IF;

  INSERT INTO public.staff_services (staff_id, service_id)
  VALUES (v_staff, v_addon);

  -- A stale mapping owned only by inactive/deleted staff must not switch a
  -- legacy salon from the all-capable fallback into whitelist mode. Once a
  -- current active staff mapping exists, the whitelist must be enforced again.
  DELETE FROM public.staff_services WHERE staff_id = v_staff;
  INSERT INTO public.staff_services (staff_id, service_id)
  VALUES
    (v_deleted_staff, v_service),
    (v_inactive_staff, v_addon);
  v_quote := public.quote_public_booking(
    v_salon, v_service, v_staff, v_start + interval '5 hours',
    v_end + interval '5 hours', ARRAY[v_addon], NULL, NULL,
    '+16045550189', NULL, false
  );
  IF v_quote->>'success' <> 'true' THEN
    RAISE EXCEPTION 'stale staff mapping activated capability whitelist: %', v_quote;
  END IF;

  INSERT INTO public.staff_services (staff_id, service_id)
  VALUES (v_staff, v_service);
  v_quote := public.quote_public_booking(
    v_salon, v_service, v_staff, v_start + interval '5 hours',
    v_end + interval '5 hours', ARRAY[v_addon], NULL, NULL,
    '+16045550189', NULL, false
  );
  IF v_quote->>'code' <> 'invalid_staff_capability' THEN
    RAISE EXCEPTION 'active staff mapping did not enforce whitelist: %', v_quote;
  END IF;
  INSERT INTO public.staff_services (staff_id, service_id)
  VALUES
    (v_staff, v_addon),
    (v_staff, v_addon_two),
    (v_staff, v_addon_three);

  UPDATE public.promotions
  SET time_start = '09:00', time_end = '09:00'
  WHERE id = v_promo;
  v_result := public.quote_public_booking(
    v_salon, v_service, v_staff, v_start + interval '4 hours',
    v_end + interval '4 hours', ARRAY[v_addon], NULL, NULL,
    '+16045550188', NULL, false
  );
  IF v_result->>'code' <> 'pricing_config_invalid' THEN
    RAISE EXCEPTION 'malformed promotion did not fail closed: %', v_result;
  END IF;

  UPDATE public.promotions
  SET time_start = NULL, time_end = NULL
  WHERE id = v_promo;
  UPDATE public.salons
  SET tax_lines = '[{"name":"","rate":0.05,"enabled":true}]'::jsonb
  WHERE id = v_salon;
  v_result := public.quote_public_booking(
    v_salon, v_service, v_staff, v_start + interval '4 hours',
    v_end + interval '4 hours', ARRAY[v_addon], NULL, NULL,
    '+16045550188', NULL, false
  );
  IF v_result->>'code' <> 'pricing_config_invalid' THEN
    RAISE EXCEPTION 'blank tax name did not fail closed: %', v_result;
  END IF;

  v_claim := public.claim_owner_booking_notification(
    v_salon, v_booking_id, 'new', ' OWNER@EXAMPLE.TEST ', ' CREATED '
  );
  IF v_claim->>'claimed' <> 'true' OR v_claim->>'status' <> 'sending' THEN
    RAISE EXCEPTION 'owner notification claim failed: %', v_claim;
  END IF;
  v_result := public.complete_owner_booking_notification(
    (v_claim->>'claim_id')::uuid, 'suppressed', NULL, 'outbound disabled'
  );
  IF v_result->>'status' <> 'suppressed' THEN
    RAISE EXCEPTION 'suppressed completion failed: %', v_result;
  END IF;
  v_claim := public.claim_owner_booking_notification(
    v_salon, v_booking_id, 'new', 'owner@example.test', 'created'
  );
  IF v_claim->>'claimed' <> 'false' OR v_claim->>'status' <> 'suppressed' THEN
    RAISE EXCEPTION 'owner duplicate was not suppressed: %', v_claim;
  END IF;

  v_claim := public.claim_owner_booking_notification(
    v_salon, v_booking_id, 'reschedule', 'owner@example.test',
    '2026-08-21t17:00:00.000z'
  );
  IF v_claim->>'claimed' <> 'true' THEN
    RAISE EXCEPTION 'first reschedule occurrence was not claimed: %', v_claim;
  END IF;
  PERFORM public.complete_owner_booking_notification(
    (v_claim->>'claim_id')::uuid, 'suppressed', NULL, 'rehearsal'
  );
  v_claim := public.claim_owner_booking_notification(
    v_salon, v_booking_id, 'reschedule', 'owner@example.test',
    '2026-08-21t18:00:00.000z'
  );
  IF v_claim->>'claimed' <> 'true' THEN
    RAISE EXCEPTION 'second valid reschedule occurrence was suppressed: %', v_claim;
  END IF;

  v_claim := public.claim_owner_booking_notification(
    v_salon, v_booking_id, 'no_show', 'owner@example.test', 'no-show-v1'
  );
  BEGIN
    UPDATE public.owner_booking_notification_claims
    SET status = 'sent', completed_at = transaction_timestamp()
    WHERE id = (v_claim->>'claim_id')::uuid;
    RAISE EXCEPTION 'owner sent provider CHECK accepted missing evidence';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  v_result := public.complete_owner_booking_notification(
    (v_claim->>'claim_id')::uuid, 'sent', NULL, NULL
  );
  IF v_result->>'code' <> 'invalid_completion'
     OR (SELECT c.status FROM public.owner_booking_notification_claims c
         WHERE c.id = (v_claim->>'claim_id')::uuid) <> 'sending' THEN
    RAISE EXCEPTION 'owner sent completion accepted without provider evidence: %', v_result;
  END IF;
  v_result := public.complete_owner_booking_notification(
    (v_claim->>'claim_id')::uuid, 'sent', 'provider-message-qa', NULL
  );
  IF v_result->>'status' <> 'sent' THEN
    RAISE EXCEPTION 'owner sent completion rejected valid provider evidence: %', v_result;
  END IF;

  INSERT INTO public.booking_notifications (
    booking_id, salon_id, notification_type, channel, status
  ) VALUES (
    v_booking_id, v_salon, 'booking_confirmation', 'sms', 'suppressed'
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.booking_notifications n
    WHERE n.booking_id = v_booking_id
      AND n.notification_type = 'booking_confirmation'
      AND n.channel = 'sms'
      AND n.status = 'suppressed'
  ) THEN
    RAISE EXCEPTION 'customer confirmation could not record suppressed';
  END IF;

  BEGIN
    INSERT INTO public.booking_notifications (
      booking_id, salon_id, notification_type, channel, status,
      twilio_message_sid, sent_at
    ) VALUES (
      v_multi_booking_id, v_salon, 'booking_confirmation', 'email', 'sent',
      NULL, transaction_timestamp()
    );
    RAISE EXCEPTION 'customer sent insert accepted missing provider receipt';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  INSERT INTO public.booking_notifications (
    booking_id, salon_id, notification_type, channel, status,
    twilio_message_sid, sent_at
  ) VALUES (
    v_multi_booking_id, v_salon, 'booking_confirmation', 'email', 'sending',
    NULL, NULL
  );
  BEGIN
    UPDATE public.booking_notifications
    SET status = 'sent', sent_at = transaction_timestamp()
    WHERE booking_id = v_multi_booking_id
      AND notification_type = 'booking_confirmation'
      AND channel = 'email';
    RAISE EXCEPTION 'customer sent update accepted missing provider receipt';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  UPDATE public.booking_notifications
  SET status = 'sent',
      twilio_message_sid = 'resend-provider-message-qa',
      sent_at = transaction_timestamp()
  WHERE booking_id = v_multi_booking_id
    AND notification_type = 'booking_confirmation'
    AND channel = 'email';
  IF NOT EXISTS (
    SELECT 1
    FROM public.booking_notifications n
    WHERE n.booking_id = v_multi_booking_id
      AND n.notification_type = 'booking_confirmation'
      AND n.channel = 'email'
      AND n.status = 'sent'
      AND n.twilio_message_sid = 'resend-provider-message-qa'
  ) THEN
    RAISE EXCEPTION 'customer sent update rejected valid provider receipt';
  END IF;
END
$rehearsal$;

ROLLBACK;

\ir check-public-booking-pricing-boundary.sql
