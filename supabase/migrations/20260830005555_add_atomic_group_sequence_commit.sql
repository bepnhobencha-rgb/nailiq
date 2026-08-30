-- Group x multi-service Phase 2B1: one atomic whole-party commit and replay.
--
-- This migration remains runtime-inert. It adds no route and keeps readiness
-- false until the management lifecycle can reschedule/cancel every member and
-- segment atomically. It never dispatches payment or notifications.

CREATE OR REPLACE FUNCTION public.create_public_group_booking_sequences(
  p_request jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $group_sequence_create$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_salon_id uuid;
  v_group_request_id uuid;
  v_expected_fingerprint text;
  v_otp_session_id uuid;
  v_otp_session public.phone_otp_sessions%ROWTYPE;
  v_health_acknowledged boolean := false;
  v_sms_consent boolean := false;
  v_notification_language text := 'vi';
  v_organizer jsonb;
  v_organizer_name text;
  v_organizer_phone text;
  v_organizer_email text;
  v_members jsonb;
  v_quote_request jsonb;
  v_request_material jsonb;
  v_request_fingerprint text;
  v_existing public.bookings%ROWTYPE;
  v_quote jsonb;
  v_group_id uuid := extensions.gen_random_uuid();
  v_group_size integer;
  v_booking_ids uuid[] := ARRAY[]::uuid[];
  v_member_receipts jsonb := '[]'::jsonb;
  v_member_quote jsonb;
  v_sequence_quote jsonb;
  v_member_input jsonb;
  v_customer jsonb;
  v_member_index integer;
  v_member_request_id uuid;
  v_booking_id uuid;
  v_organizer_booking_id uuid;
  v_member_phone text;
  v_member_email text;
  v_profile_id uuid;
  v_first jsonb;
  v_segment jsonb;
  v_segment_id uuid;
  v_segment_ids uuid[];
  v_segment_position integer;
  v_member_receipt jsonb;
  v_addon jsonb;
  v_addon_remaining integer;
  v_addon_persist integer;
  v_service_total integer;
  v_addon_total integer;
  v_snapshot jsonb;
  v_effective_plan text;
  v_feature_flags jsonb;
  v_phone_otp_enabled boolean := false;
  v_health_ack_required boolean := false;
  v_salon_slug text;
  v_month_count bigint;
  v_month_start timestamptz := (
    pg_catalog.date_trunc(
      'month', transaction_timestamp() AT TIME ZONE 'UTC'
    ) AT TIME ZONE 'UTC'
  );
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'unauthorized'
    );
  END IF;
  IF p_request IS NULL
     OR pg_catalog.jsonb_typeof(p_request) IS DISTINCT FROM 'object'
     OR (p_request - ARRAY[
       'contract_version', 'salon_id', 'group_request_id',
       'requested_anchor_utc', 'seat_together', 'organizer', 'members',
       'apply_email_discount', 'expected_pricing_fingerprint',
       'otp_session_id', 'health_acknowledged', 'sms_consent',
       'notification_language'
     ]::text[]) <> '{}'::jsonb THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'invalid_input'
    );
  END IF;
  BEGIN
    IF (p_request->>'contract_version')::integer <> 1 THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'unsupported_contract'
      );
    END IF;
    v_salon_id := (p_request->>'salon_id')::uuid;
    v_group_request_id := (p_request->>'group_request_id')::uuid;
    IF p_request ? 'otp_session_id'
       AND p_request->'otp_session_id' <> 'null'::jsonb
       AND pg_catalog.jsonb_typeof(p_request->'otp_session_id') <> 'string' THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'invalid_input'
      );
    END IF;
    v_otp_session_id := nullif(
      pg_catalog.btrim(coalesce(p_request->>'otp_session_id', '')),
      ''
    )::uuid;
    IF p_request ? 'health_acknowledged'
       AND pg_catalog.jsonb_typeof(p_request->'health_acknowledged') <> 'boolean' THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'invalid_input'
      );
    END IF;
    v_health_acknowledged := coalesce(
      (p_request->>'health_acknowledged')::boolean,
      false
    );
    IF p_request ? 'sms_consent'
       AND pg_catalog.jsonb_typeof(p_request->'sms_consent') <> 'boolean' THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'invalid_input'
      );
    END IF;
    v_sms_consent := coalesce((p_request->>'sms_consent')::boolean, false);
    IF p_request ? 'notification_language'
       AND (
         pg_catalog.jsonb_typeof(p_request->'notification_language') <> 'string'
         OR p_request->>'notification_language' NOT IN ('en', 'vi')
       ) THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'invalid_input'
      );
    END IF;
    v_notification_language := coalesce(
      p_request->>'notification_language',
      'vi'
    );
  EXCEPTION
    WHEN invalid_text_representation OR invalid_datetime_format
      OR datetime_field_overflow THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'invalid_input'
      );
  END;

  v_expected_fingerprint := p_request->>'expected_pricing_fingerprint';
  v_organizer := p_request->'organizer';
  v_members := p_request->'members';
  IF v_salon_id IS NULL
     OR v_group_request_id IS NULL
     OR coalesce(v_expected_fingerprint, '') !~ '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(v_organizer) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_members) IS DISTINCT FROM 'array' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'invalid_input'
    );
  END IF;
  v_organizer_name := pg_catalog.btrim(coalesce(v_organizer->>'name', ''));
  v_organizer_phone := pg_catalog.regexp_replace(
    coalesce(v_organizer->>'phone', ''),
    '\D',
    '',
    'g'
  );
  v_organizer_email := nullif(
    lower(pg_catalog.btrim(coalesce(v_organizer->>'email', ''))),
    ''
  );
  v_group_size := pg_catalog.jsonb_array_length(v_members);

  v_quote_request := p_request - ARRAY[
    'expected_pricing_fingerprint', 'otp_session_id',
    'health_acknowledged', 'sms_consent', 'notification_language'
  ]::text[];
  v_request_material := v_quote_request || pg_catalog.jsonb_build_object(
    'organizer', pg_catalog.jsonb_build_object(
      'name', v_organizer_name,
      'phone', v_organizer_phone,
      'email', v_organizer_email
    ),
    'expected_pricing_fingerprint', v_expected_fingerprint,
    'health_acknowledged', v_health_acknowledged,
    'sms_consent', v_sms_consent,
    'notification_language', v_notification_language
  );
  IF v_otp_session_id IS NOT NULL THEN
    v_request_material := v_request_material || pg_catalog.jsonb_build_object(
      'otp_session_id', v_otp_session_id
    );
  END IF;
  v_request_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_request_material::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-sequence-idempotency:' || v_salon_id::text || ':' ||
        v_group_request_id::text,
      0
    )
  );
  SELECT b.* INTO v_existing
  FROM public.bookings b
  WHERE b.salon_id = v_salon_id
    AND b.idempotency_key = v_group_request_id
    AND b.group_id IS NOT NULL
    AND b.is_group_organizer IS TRUE
    AND b.schedule_model = 'segments_v1'
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.public_booking_request_fingerprint
         IS DISTINCT FROM v_request_fingerprint
       OR v_existing.public_booking_pricing_fingerprint
         IS DISTINCT FROM v_expected_fingerprint
       OR pg_catalog.jsonb_typeof(v_existing.public_booking_pricing_snapshot)
         IS DISTINCT FROM 'object'
       OR v_existing.public_booking_pricing_snapshot->>'group_id'
         IS DISTINCT FROM v_existing.group_id::text
       OR v_existing.public_booking_pricing_snapshot->>'organizer_booking_id'
         IS DISTINCT FROM v_existing.id::text
       OR pg_catalog.jsonb_array_length(
         v_existing.public_booking_pricing_snapshot->'booking_ids'
       ) <> v_existing.group_size THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'idempotency_conflict'
      );
    END IF;
    IF (v_otp_session_id IS NULL AND v_existing.otp_session_id IS NOT NULL)
       OR (v_otp_session_id IS NOT NULL AND (
         v_existing.otp_session_id IS DISTINCT FROM v_otp_session_id
         OR v_existing.verification_method NOT IN ('otp', 'both')
         OR v_existing.verification_completed_at IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM public.phone_otp_sessions otp
           WHERE otp.id = v_otp_session_id
             AND otp.salon_id = v_existing.salon_id
             AND public.canonical_phone(otp.phone)
               = public.canonical_phone(v_existing.client_phone)
             AND otp.consumed_at IS NOT NULL
             AND otp.consumed_by_booking_id = v_existing.id
         )
       )) THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'idempotency_conflict'
      );
    END IF;
    IF v_existing.status <> 'confirmed'
       OR v_existing.deleted_at IS NOT NULL
       OR (
         SELECT count(*)
         FROM public.bookings b
         WHERE b.salon_id = v_existing.salon_id
           AND b.group_id = v_existing.group_id
           AND b.status = 'confirmed'
           AND b.deleted_at IS NULL
       ) <> v_existing.group_size
       OR EXISTS (
         SELECT 1
         FROM public.bookings b
         WHERE b.salon_id = v_existing.salon_id
           AND b.group_id = v_existing.group_id
           AND (
             b.schedule_model <> 'segments_v1'
             OR b.sequence_version <> 1
             OR NOT EXISTS (
               SELECT 1 FROM public.booking_service_segments seg
               WHERE seg.booking_id = b.id
                 AND seg.reservation_status = 'confirmed'
             )
           )
       ) THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'booking_state_changed',
        'group_id', v_existing.group_id
      );
    END IF;
    RETURN v_existing.public_booking_pricing_snapshot ||
      pg_catalog.jsonb_build_object(
        'success', true,
        'code', 'booked',
        'idempotent', true,
        'pricing_snapshot', v_existing.public_booking_pricing_snapshot
      );
  END IF;

  v_quote := public.resolve_public_group_sequence_quote(v_quote_request, true);
  IF coalesce(v_quote->>'success', 'false') <> 'true' THEN
    RETURN v_quote;
  END IF;
  IF v_quote->>'pricing_fingerprint' IS DISTINCT FROM v_expected_fingerprint THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'pricing_changed',
      'quote', v_quote
    );
  END IF;

  SELECT
    CASE
      WHEN s.plan_override IN ('free', 'pro', 'premium') THEN s.plan_override
      WHEN s.subscription_plan IN ('free', 'pro', 'premium')
        THEN s.subscription_plan
      ELSE 'free'
    END,
    coalesce(s.feature_flags, '{}'::jsonb),
    coalesce(s.phone_otp_enabled, false),
    CASE
      WHEN s.health_ack_required IS NOT NULL THEN s.health_ack_required
      ELSE lower(coalesce(s.vertical, 'nail_salon')) IN (
        'head_spa', 'facial', 'massage', 'waxing'
      )
    END,
    nullif(pg_catalog.btrim(s.slug), '')
  INTO v_effective_plan, v_feature_flags, v_phone_otp_enabled,
    v_health_ack_required, v_salon_slug
  FROM public.salons s
  WHERE s.id = v_salon_id AND s.archived_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'invalid_reference'
    );
  END IF;
  IF v_salon_slug IS NULL
     OR length(v_salon_slug) > 100
     OR v_salon_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'pricing_config_invalid'
    );
  END IF;
  IF v_health_ack_required AND NOT v_health_acknowledged THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'health_ack_required'
    );
  END IF;
  IF v_effective_plan = 'free'
     AND coalesce(v_feature_flags->>'unlimited_bookings', 'false') <> 'true' THEN
    SELECT count(*) INTO v_month_count
    FROM public.bookings b
    WHERE b.salon_id = v_salon_id
      AND b.start_time_utc >= v_month_start
      AND b.start_time_utc < v_month_start + interval '1 month'
      AND b.status <> 'cancelled';
    IF v_month_count + v_group_size > 50 THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'monthly_booking_limit_reached'
      );
    END IF;
  END IF;

  IF v_phone_otp_enabled THEN
    IF v_otp_session_id IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'otp_required'
      );
    END IF;
    SELECT otp.* INTO v_otp_session
    FROM public.phone_otp_sessions otp
    WHERE otp.id = v_otp_session_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_otp_session.salon_id IS DISTINCT FROM v_salon_id
       OR public.canonical_phone(v_otp_session.phone)
         IS DISTINCT FROM public.canonical_phone(v_organizer_phone)
       OR v_otp_session.verified_at IS NULL
       OR v_otp_session.expires_at <= transaction_timestamp() THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'invalid_otp_session'
      );
    END IF;
    IF v_otp_session.consumed_at IS NOT NULL
       OR v_otp_session.consumed_by_booking_id IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'otp_session_used'
      );
    END IF;
  ELSIF v_otp_session_id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'otp_not_required'
    );
  END IF;

  BEGIN
    FOR v_member_quote IN
      SELECT value
      FROM pg_catalog.jsonb_array_elements(v_quote->'member_quotes')
      -- Guests are persisted first so the organizer's INSERT can carry the
      -- final immutable whole-party receipt. The parent schedule guard rightly
      -- rejects a later snapshot mutation on a confirmed sequence booking.
      ORDER BY CASE WHEN (value->>'member_index')::integer = 0 THEN 1 ELSE 0 END,
        (value->>'member_index')::integer
    LOOP
      v_member_index := (v_member_quote->>'member_index')::integer;
      v_member_request_id := (v_member_quote->>'member_request_id')::uuid;
      v_member_input := v_members->v_member_index;
      v_customer := v_member_input->'customer';
      v_sequence_quote := v_member_quote->'quote';
      v_booking_id := extensions.gen_random_uuid();
      v_segment_ids := ARRAY[]::uuid[];
      v_service_total := 0;
      v_addon_total := 0;
      v_member_phone := pg_catalog.regexp_replace(
        coalesce(v_customer->>'phone', ''),
        '\D',
        '',
        'g'
      );
      IF v_member_phone = '' THEN
        v_member_phone := NULL;
      END IF;
      v_member_email := nullif(
        lower(pg_catalog.btrim(coalesce(v_customer->>'email', ''))),
        ''
      );
      v_first := v_sequence_quote->'segments'->0;
      v_profile_id := NULL;
      IF v_member_phone IS NOT NULL THEN
        v_profile_id := public.resolve_client_profile(
          v_member_phone,
          pg_catalog.btrim(v_customer->>'name'),
          v_member_email,
          (v_first->>'staff_id')::uuid
        );
      END IF;
      FOR v_segment IN
        SELECT value
        FROM pg_catalog.jsonb_array_elements(v_sequence_quote->'segments')
      LOOP
        v_segment_ids := pg_catalog.array_append(
          v_segment_ids,
          extensions.gen_random_uuid()
        );
        v_service_total := v_service_total
          + (v_segment->>'service_price_cents')::integer;
        v_addon_total := v_addon_total
          + (v_segment->>'addon_price_cents')::integer;
      END LOOP;
      v_member_receipt := pg_catalog.jsonb_build_object(
        'member_index', v_member_index,
        'member_request_id', v_member_request_id,
        'booking_id', v_booking_id,
        'segment_ids', pg_catalog.to_jsonb(v_segment_ids)
      );
      IF v_member_index = 0 THEN
        v_organizer_booking_id := v_booking_id;
        v_booking_ids := pg_catalog.array_prepend(v_booking_id, v_booking_ids);
        v_member_receipts := pg_catalog.jsonb_build_array(v_member_receipt)
          || v_member_receipts;
        v_snapshot := v_quote || pg_catalog.jsonb_build_object(
          'group_id', v_group_id,
          'organizer_booking_id', v_organizer_booking_id,
          'booking_ids', pg_catalog.to_jsonb(v_booking_ids),
          'member_receipts', v_member_receipts,
          'sms_consent', v_sms_consent,
          'notification_language', v_notification_language,
          'salon_slug', v_salon_slug,
          'health_acknowledged', v_health_acknowledged
        );
      ELSE
        v_booking_ids := pg_catalog.array_append(v_booking_ids, v_booking_id);
        v_member_receipts := v_member_receipts
          || pg_catalog.jsonb_build_array(v_member_receipt);
      END IF;

      INSERT INTO public.bookings (
        id, salon_id, service_id, staff_id, resource_id,
        client_name, client_phone, client_email, client_notes, client_locale,
        start_time_utc, end_time_utc, status, confirmed_at,
        verification_method, verification_completed_at, otp_session_id,
        health_ack_at,
        price_cents, addon_service_id, addon_price_cents,
        promo_id, original_price_cents, subtotal_cents, tax_amount_cents,
        source, booking_channel, staff_requested_by_client,
        idempotency_key, client_profile_id,
        group_id, group_size, seat_together, is_party_member,
        is_group_organizer,
        schedule_model, sequence_version,
        public_booking_request_fingerprint,
        public_booking_pricing_fingerprint,
        public_booking_pricing_snapshot
      ) VALUES (
        v_booking_id, v_salon_id,
        (v_first->>'service_id')::uuid,
        (v_first->>'staff_id')::uuid,
        nullif(v_first->>'resource_id', '')::uuid,
        pg_catalog.btrim(v_customer->>'name'),
        v_member_phone, v_member_email, NULL,
        CASE WHEN v_member_index = 0 THEN v_notification_language ELSE NULL END,
        (v_sequence_quote->>'parent_start_time_utc')::timestamptz,
        (v_sequence_quote->>'parent_end_time_utc')::timestamptz,
        'confirmed', transaction_timestamp(),
        CASE
          WHEN v_member_index = 0 AND v_phone_otp_enabled THEN 'otp'
          ELSE NULL
        END,
        CASE
          WHEN v_member_index = 0 AND v_phone_otp_enabled
            THEN v_otp_session.verified_at
          ELSE NULL
        END,
        CASE
          WHEN v_member_index = 0 AND v_phone_otp_enabled
            THEN v_otp_session_id
          ELSE NULL
        END,
        CASE
          WHEN v_member_index = 0 AND v_health_acknowledged
            THEN transaction_timestamp()
          ELSE NULL
        END,
        v_service_total,
        nullif(v_first->>'first_addon_id', '')::uuid,
        CASE WHEN v_addon_total > 0 THEN v_addon_total ELSE NULL END,
        nullif(v_first->>'promo_id', '')::uuid,
        (v_sequence_quote->>'original_price_cents')::integer,
        (v_sequence_quote->>'subtotal_cents')::integer,
        (v_sequence_quote->>'tax_cents')::integer,
        'appointment', 'online',
        coalesce((v_member_input->>'same_staff_for_all')::boolean, false),
        CASE
          WHEN v_member_index = 0 THEN v_group_request_id
          ELSE v_member_request_id
        END,
        v_profile_id,
        v_group_id, v_group_size, coalesce((p_request->>'seat_together')::boolean, false),
        v_profile_id IS NULL, v_member_index = 0,
        'segments_v1', 1,
        CASE WHEN v_member_index = 0 THEN v_request_fingerprint ELSE NULL END,
        v_expected_fingerprint,
        CASE WHEN v_member_index = 0 THEN v_snapshot ELSE v_sequence_quote END
      );

      FOR v_segment IN
        SELECT value
        FROM pg_catalog.jsonb_array_elements(v_sequence_quote->'segments')
        ORDER BY (value->>'position')::integer
      LOOP
        v_segment_position := (v_segment->>'position')::integer;
        v_segment_id := v_segment_ids[v_segment_position + 1];
        INSERT INTO public.booking_service_segments (
          id, booking_id, salon_id, position, line_id, service_id, staff_id,
          resource_id, customer_start_utc, customer_end_utc,
          occupied_start_utc, occupied_end_utc, prep_minutes,
          service_duration_minutes, sequential_addon_minutes,
          trailing_buffer_minutes, service_name, staff_name,
          original_service_price_cents, service_pre_voucher_cents,
          addon_pre_voucher_cents, promo_discount_cents,
          email_discount_cents, voucher_discount_cents,
          service_price_cents, addon_price_cents, subtotal_cents,
          tax_cents, total_cents, promo_id, addon_lines, tax_breakdown,
          reservation_status
        ) VALUES (
          v_segment_id, v_booking_id, v_salon_id,
          (v_segment->>'position')::smallint,
          (v_segment->>'line_id')::uuid,
          (v_segment->>'service_id')::uuid,
          (v_segment->>'staff_id')::uuid,
          nullif(v_segment->>'resource_id', '')::uuid,
          (v_segment->>'customer_start_utc')::timestamptz,
          (v_segment->>'customer_end_utc')::timestamptz,
          (v_segment->>'occupied_start_utc')::timestamptz,
          (v_segment->>'occupied_end_utc')::timestamptz,
          (v_segment->>'prep_minutes')::integer,
          (v_segment->>'service_duration_minutes')::integer,
          (v_segment->>'sequential_addon_minutes')::integer,
          (v_segment->>'trailing_buffer_minutes')::integer,
          v_segment->>'service_name', v_segment->>'staff_name',
          (v_segment->>'original_service_price_cents')::integer,
          (v_segment->>'service_pre_voucher_cents')::integer,
          (v_segment->>'addon_pre_voucher_cents')::integer,
          (v_segment->>'promo_discount_cents')::integer,
          (v_segment->>'email_discount_cents')::integer,
          (v_segment->>'voucher_discount_cents')::integer,
          (v_segment->>'service_price_cents')::integer,
          (v_segment->>'addon_price_cents')::integer,
          (v_segment->>'subtotal_cents')::integer,
          (v_segment->>'tax_cents')::integer,
          (v_segment->>'total_cents')::integer,
          nullif(v_segment->>'promo_id', '')::uuid,
          v_segment->'addon_lines', v_segment->'tax_breakdown', 'confirmed'
        );

        v_addon_remaining := (v_segment->>'addon_price_cents')::integer;
        FOR v_addon IN
          SELECT value
          FROM pg_catalog.jsonb_array_elements(v_segment->'addon_lines')
        LOOP
          v_addon_persist := least(
            (v_addon->>'price_cents')::integer,
            v_addon_remaining
          );
          v_addon_remaining := v_addon_remaining - v_addon_persist;
          INSERT INTO public.booking_addons (
            booking_id, booking_service_segment_id, service_id,
            name, price_cents, duration_minutes
          ) VALUES (
            v_booking_id, v_segment_id,
            (v_addon->>'service_id')::uuid,
            v_addon->>'name', v_addon_persist,
            (v_addon->>'duration_minutes')::integer
          );
        END LOOP;
        IF v_addon_remaining <> 0 THEN
          RAISE EXCEPTION 'group sequence addon allocation invariant failed';
        END IF;
      END LOOP;
      IF pg_catalog.cardinality(v_segment_ids)
         <> pg_catalog.jsonb_array_length(v_sequence_quote->'segments') THEN
        RAISE EXCEPTION 'group sequence segment count invariant failed';
      END IF;
    END LOOP;

    IF pg_catalog.cardinality(v_booking_ids) <> v_group_size
       OR v_organizer_booking_id IS NULL
       OR pg_catalog.jsonb_array_length(v_member_receipts) <> v_group_size THEN
      RAISE EXCEPTION 'group sequence member count invariant failed';
    END IF;

    IF (v_quote->>'email_discount_cents')::integer > 0 THEN
      UPDATE public.client_profiles cp
      SET email_discount_claimed_at = transaction_timestamp(),
          updated_at = transaction_timestamp()
      FROM public.bookings b
      WHERE b.id = v_organizer_booking_id
        AND b.client_profile_id = cp.id
        AND cp.phone = v_organizer_phone
        AND cp.email_discount_claimed_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'group sequence email discount invariant failed';
      END IF;
    END IF;

    IF v_phone_otp_enabled THEN
      UPDATE public.phone_otp_sessions otp
      SET consumed_at = transaction_timestamp(),
          consumed_by_booking_id = v_organizer_booking_id
      WHERE otp.id = v_otp_session_id
        AND otp.consumed_at IS NULL
        AND otp.consumed_by_booking_id IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'group sequence OTP consumption invariant failed';
      END IF;
      UPDATE public.client_profiles cp
      SET phone_verified_at = CASE
            WHEN cp.phone_verified_at IS NULL
              OR cp.phone_verified_at < v_otp_session.verified_at
              THEN v_otp_session.verified_at
            ELSE cp.phone_verified_at
          END,
          updated_at = transaction_timestamp()
      FROM public.bookings b
      WHERE b.id = v_organizer_booking_id
        AND b.client_profile_id = cp.id
        AND public.canonical_phone(cp.phone)
          = public.canonical_phone(v_organizer_phone);
      IF NOT FOUND THEN
        RAISE EXCEPTION 'group sequence OTP profile invariant failed';
      END IF;
    END IF;

    RETURN v_snapshot || pg_catalog.jsonb_build_object(
      'success', true,
      'code', 'booked',
      'idempotent', false,
      'pricing_snapshot', v_snapshot
    );
  EXCEPTION
    WHEN exclusion_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'slot_conflict'
      );
    WHEN unique_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'write_conflict'
      );
    WHEN check_violation OR foreign_key_violation THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'invalid_reference'
      );
  END;
END;
$group_sequence_create$;

REVOKE ALL ON FUNCTION public.create_public_group_booking_sequences(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_group_booking_sequences(jsonb)
  TO service_role;

-- Read-only response-loss reconciliation. The canonical create checks replay
-- before availability; this separate RPC gives routes a proof-only path that
-- cannot create profiles, bookings, segments, discounts, or OTP consumption.
CREATE OR REPLACE FUNCTION public.replay_public_group_booking_sequences(
  p_request jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $group_sequence_replay$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_salon_id uuid;
  v_group_request_id uuid;
  v_expected_fingerprint text;
  v_otp_session_id uuid;
  v_organizer jsonb;
  v_quote_request jsonb;
  v_request_material jsonb;
  v_request_fingerprint text;
  v_existing public.bookings%ROWTYPE;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'unauthorized'
    );
  END IF;
  IF p_request IS NULL
     OR pg_catalog.jsonb_typeof(p_request) IS DISTINCT FROM 'object'
     OR (p_request - ARRAY[
       'contract_version', 'salon_id', 'group_request_id',
       'requested_anchor_utc', 'seat_together', 'organizer', 'members',
       'apply_email_discount', 'expected_pricing_fingerprint',
       'otp_session_id', 'health_acknowledged', 'sms_consent',
       'notification_language'
     ]::text[]) <> '{}'::jsonb THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'invalid_input'
    );
  END IF;
  BEGIN
    IF (p_request->>'contract_version')::integer <> 1 THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'unsupported_contract'
      );
    END IF;
    v_salon_id := (p_request->>'salon_id')::uuid;
    v_group_request_id := (p_request->>'group_request_id')::uuid;
    v_otp_session_id := nullif(
      pg_catalog.btrim(coalesce(p_request->>'otp_session_id', '')),
      ''
    )::uuid;
  EXCEPTION
    WHEN invalid_text_representation THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'invalid_input'
      );
  END;
  v_expected_fingerprint := p_request->>'expected_pricing_fingerprint';
  v_organizer := p_request->'organizer';
  IF v_salon_id IS NULL
     OR v_group_request_id IS NULL
     OR coalesce(v_expected_fingerprint, '') !~ '^[0-9a-f]{64}$'
     OR pg_catalog.jsonb_typeof(v_organizer) IS DISTINCT FROM 'object' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'invalid_input'
    );
  END IF;
  v_quote_request := p_request - ARRAY[
    'expected_pricing_fingerprint', 'otp_session_id',
    'health_acknowledged', 'sms_consent', 'notification_language'
  ]::text[];
  v_request_material := v_quote_request || pg_catalog.jsonb_build_object(
    'organizer', pg_catalog.jsonb_build_object(
      'name', pg_catalog.btrim(coalesce(v_organizer->>'name', '')),
      'phone', pg_catalog.regexp_replace(
        coalesce(v_organizer->>'phone', ''), '\D', '', 'g'
      ),
      'email', nullif(
        lower(pg_catalog.btrim(coalesce(v_organizer->>'email', ''))),
        ''
      )
    ),
    'expected_pricing_fingerprint', v_expected_fingerprint,
    'health_acknowledged', coalesce(
      (p_request->>'health_acknowledged')::boolean,
      false
    ),
    'sms_consent', coalesce((p_request->>'sms_consent')::boolean, false),
    'notification_language', coalesce(
      p_request->>'notification_language',
      'vi'
    )
  );
  IF v_otp_session_id IS NOT NULL THEN
    v_request_material := v_request_material || pg_catalog.jsonb_build_object(
      'otp_session_id', v_otp_session_id
    );
  END IF;
  v_request_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_request_material::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-sequence-idempotency:' || v_salon_id::text || ':' ||
        v_group_request_id::text,
      0
    )
  );
  SELECT b.* INTO v_existing
  FROM public.bookings b
  WHERE b.salon_id = v_salon_id
    AND b.idempotency_key = v_group_request_id
    AND b.group_id IS NOT NULL
    AND b.is_group_organizer IS TRUE
    AND b.schedule_model = 'segments_v1'
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'replay_not_found'
    );
  END IF;
  IF v_existing.public_booking_request_fingerprint
       IS DISTINCT FROM v_request_fingerprint
     OR v_existing.public_booking_pricing_fingerprint
       IS DISTINCT FROM v_expected_fingerprint
     OR pg_catalog.jsonb_typeof(v_existing.public_booking_pricing_snapshot)
       IS DISTINCT FROM 'object'
     OR v_existing.public_booking_pricing_snapshot->>'group_id'
       IS DISTINCT FROM v_existing.group_id::text
     OR v_existing.public_booking_pricing_snapshot->>'organizer_booking_id'
       IS DISTINCT FROM v_existing.id::text
     OR (v_otp_session_id IS NULL AND v_existing.otp_session_id IS NOT NULL)
     OR (v_otp_session_id IS NOT NULL AND (
       v_existing.otp_session_id IS DISTINCT FROM v_otp_session_id
       OR NOT EXISTS (
         SELECT 1 FROM public.phone_otp_sessions otp
         WHERE otp.id = v_otp_session_id
           AND otp.salon_id = v_existing.salon_id
           AND otp.consumed_at IS NOT NULL
           AND otp.consumed_by_booking_id = v_existing.id
       )
     )) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'idempotency_conflict'
    );
  END IF;
  IF v_existing.status <> 'confirmed'
     OR v_existing.deleted_at IS NOT NULL
     OR (
       SELECT count(*)
       FROM public.bookings b
       WHERE b.salon_id = v_existing.salon_id
         AND b.group_id = v_existing.group_id
         AND b.status = 'confirmed'
         AND b.deleted_at IS NULL
     ) <> v_existing.group_size
     OR EXISTS (
       SELECT 1
       FROM public.bookings b
       WHERE b.salon_id = v_existing.salon_id
         AND b.group_id = v_existing.group_id
         AND (
           b.schedule_model <> 'segments_v1'
           OR b.sequence_version <> 1
           OR NOT EXISTS (
             SELECT 1 FROM public.booking_service_segments seg
             WHERE seg.booking_id = b.id
               AND seg.reservation_status = 'confirmed'
           )
         )
     ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'booking_state_changed',
      'group_id', v_existing.group_id
    );
  END IF;
  RETURN v_existing.public_booking_pricing_snapshot ||
    pg_catalog.jsonb_build_object(
      'success', true,
      'code', 'booked',
      'idempotent', true,
      'pricing_snapshot', v_existing.public_booking_pricing_snapshot
    );
END;
$group_sequence_replay$;

REVOKE ALL ON FUNCTION public.replay_public_group_booking_sequences(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replay_public_group_booking_sequences(jsonb)
  TO service_role;

COMMENT ON FUNCTION public.create_public_group_booking_sequences(jsonb) IS
  'Service-role-only whole-party group sequence commit. It quotes and locks every member before one transactional write, consumes only the organizer OTP, and exact-replays before fresh capacity evaluation. It never calls a payment or notification provider.';
COMMENT ON FUNCTION public.replay_public_group_booking_sequences(jsonb) IS
  'Service-role-only read-only response-loss reconciliation for a fully persisted group sequence receipt.';

-- Phase 2B1 proves commit/replay availability but deliberately keeps runtime
-- readiness false until group sequence management is atomic too.
DO $group_sequence_readiness_patch$
DECLARE
  v_definition text;
  v_old text := $old$'atomic_commit_ready', false,
    'ready', false$old$;
  v_new text := $new$'atomic_commit_ready',
      pg_catalog.to_regprocedure(
        'public.create_public_group_booking_sequences(jsonb)'
      ) IS NOT NULL
      AND pg_catalog.to_regprocedure(
        'public.replay_public_group_booking_sequences(jsonb)'
      ) IS NOT NULL
      AND NOT has_function_privilege(
        'anon',
        'public.create_public_group_booking_sequences(jsonb)',
        'EXECUTE'
      )
      AND NOT has_function_privilege(
        'authenticated',
        'public.create_public_group_booking_sequences(jsonb)',
        'EXECUTE'
      )
      AND has_function_privilege(
        'service_role',
        'public.create_public_group_booking_sequences(jsonb)',
        'EXECUTE'
      )
      AND NOT has_function_privilege(
        'anon',
        'public.replay_public_group_booking_sequences(jsonb)',
        'EXECUTE'
      )
      AND NOT has_function_privilege(
        'authenticated',
        'public.replay_public_group_booking_sequences(jsonb)',
        'EXECUTE'
      )
      AND has_function_privilege(
        'service_role',
        'public.replay_public_group_booking_sequences(jsonb)',
        'EXECUTE'
      ),
    'management_lifecycle_ready', false,
    'ready', false$new$;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.load_public_group_sequence_readiness(uuid)'::regprocedure
  ) INTO v_definition;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'group sequence readiness contract drifted';
  END IF;
  EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END;
$group_sequence_readiness_patch$;

DO $group_sequence_commit_contract_proof$
DECLARE
  v_target regprocedure;
  v_definition text;
BEGIN
  FOREACH v_target IN ARRAY ARRAY[
    pg_catalog.to_regprocedure(
      'public.create_public_group_booking_sequences(jsonb)'
    ),
    pg_catalog.to_regprocedure(
      'public.replay_public_group_booking_sequences(jsonb)'
    )
  ]
  LOOP
    IF v_target IS NULL THEN
      RAISE EXCEPTION 'group sequence commit contract signature missing';
    END IF;
    IF has_function_privilege('anon', v_target, 'EXECUTE')
       OR has_function_privilege('authenticated', v_target, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_target, 'EXECUTE') THEN
      RAISE EXCEPTION 'group sequence commit ACL mismatch: %', v_target;
    END IF;
    SELECT pg_catalog.pg_get_functiondef(v_target)
    INTO v_definition;
    IF pg_catalog.strpos(v_definition, 'SECURITY DEFINER') = 0
       OR pg_catalog.strpos(v_definition, 'SET search_path TO') = 0 THEN
      RAISE EXCEPTION 'group sequence commit hardening mismatch: %', v_target;
    END IF;
  END LOOP;
  SELECT pg_catalog.pg_get_functiondef(
    'public.load_public_group_sequence_readiness(uuid)'::regprocedure
  ) INTO v_definition;
  IF pg_catalog.strpos(v_definition, '''management_lifecycle_ready'', false') = 0
     OR pg_catalog.strpos(v_definition, '''ready'', false') = 0 THEN
    RAISE EXCEPTION 'Phase 2B1 must remain runtime disabled';
  END IF;
END;
$group_sequence_commit_contract_proof$;
