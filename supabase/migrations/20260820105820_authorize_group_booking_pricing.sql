-- Sellable V1 / Group pricing Phase A.
--
-- Add an authoritative, service-only quote/create boundary for Group/Party
-- bookings. The legacy insert_group_bookings(jsonb) body remains for scoped
-- service-role compatibility (controlled after-hours / Voice), but direct
-- anonymous and authenticated execution is closed in this migration.

DO $group_legacy_rollout_preflight$
DECLARE
  v_enabled_count bigint;
  v_enabled_sample jsonb;
BEGIN
  SELECT
    count(*),
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', enabled.id,
          'slug', enabled.slug
        ) ORDER BY enabled.slug
      ) FILTER (WHERE enabled.sample_rank <= 10),
      '[]'::jsonb
    )
  INTO v_enabled_count, v_enabled_sample
  FROM (
    SELECT
      s.id,
      s.slug,
      row_number() OVER (ORDER BY s.slug) AS sample_rank
    FROM public.salons s
    WHERE s.archived_at IS NULL
      AND s.feature_flags -> 'group_booking_enabled' = 'true'::jsonb
  ) enabled;

  IF v_enabled_count > 0 THEN
    RAISE EXCEPTION
      'group pricing rollout blocked: % non-archived salon(s) still have feature_flags.group_booking_enabled=true; sample=%; disable the flag, deploy DB+app, verify canonical routes, then re-enable deliberately',
      v_enabled_count,
      v_enabled_sample;
  END IF;
END;
$group_legacy_rollout_preflight$;

REVOKE ALL ON FUNCTION public.insert_group_bookings(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_group_bookings(jsonb)
  TO service_role;

COMMENT ON FUNCTION public.insert_group_bookings(jsonb) IS
  'Legacy Group/Party writer retained only for scoped service-role compatibility. Public browser groups must use the service API plus quote_group_booking/create_group_bookings.';

DO $group_idempotency_preflight$
DECLARE
  v_duplicate record;
BEGIN
  SELECT b.salon_id, b.idempotency_key, count(*) AS duplicate_count
  INTO v_duplicate
  FROM public.bookings b
  WHERE b.group_id IS NOT NULL
    AND b.is_group_organizer IS TRUE
    AND b.idempotency_key IS NOT NULL
  GROUP BY b.salon_id, b.idempotency_key
  HAVING count(*) > 1
  ORDER BY count(*) DESC
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'duplicate group organizer idempotency requires review: salon=% key=% count=%',
      v_duplicate.salon_id,
      v_duplicate.idempotency_key,
      v_duplicate.duplicate_count;
  END IF;
END;
$group_idempotency_preflight$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_group_idempotency_once
  ON public.bookings (salon_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND group_id IS NOT NULL
    AND is_group_organizer IS TRUE;

COMMENT ON INDEX public.idx_bookings_group_idempotency_once IS
  'One canonical organizer per salon/group request key. Group members do not carry the request key.';

CREATE OR REPLACE FUNCTION public.resolve_group_booking_pricing(
  p_salon_id uuid,
  p_bookings jsonb,
  p_voucher_id uuid,
  p_client_phone text,
  p_client_email text,
  p_apply_email_discount boolean,
  p_lock_claims boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $group_pricing$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_group_size integer;
  v_booking jsonb;
  v_normalized jsonb := '[]'::jsonb;
  v_base_members jsonb := '[]'::jsonb;
  v_final_members jsonb := '[]'::jsonb;
  v_member jsonb;
  v_left jsonb;
  v_right jsonb;
  v_ord integer;
  v_member_index integer;
  v_service_id uuid;
  v_staff_id uuid;
  v_resource_id uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_addon_ids uuid[];
  v_member_phone text;
  v_member_email text;
  v_staff_requested boolean;
  v_wave smallint;
  v_seat_together boolean;
  v_digits text := pg_catalog.regexp_replace(
    coalesce(p_client_phone, ''), '\D', '', 'g'
  );
  v_quote jsonb;
  v_currency text;
  v_tax_lines jsonb;
  v_tax_line jsonb;
  v_tax_breakdown jsonb := '[]'::jsonb;
  v_member_tax_breakdown jsonb;
  v_tax_rate numeric;
  v_tax_enabled boolean;
  v_group_tax_line_amount integer;
  v_tax_floor_sum integer;
  v_tax_remainder_count integer;
  v_member_original integer;
  v_service_pre integer;
  v_addon_pre integer;
  v_email_alloc integer;
  v_voucher_alloc integer;
  v_member_pre_voucher integer;
  v_member_subtotal integer;
  v_member_tax integer;
  v_member_total integer;
  v_final_service integer;
  v_final_addon integer;
  v_group_original integer := 0;
  v_group_promo integer := 0;
  v_group_email integer := 0;
  v_group_pre_voucher integer := 0;
  v_group_voucher integer := 0;
  v_group_subtotal integer := 0;
  v_group_tax integer := 0;
  v_group_total integer := 0;
  v_remaining_voucher integer := 0;
  v_profile_id uuid;
  v_email_claimed_at timestamptz;
  v_voucher public.vouchers%ROWTYPE;
  v_material jsonb;
  v_fingerprint text;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;

  IF p_salon_id IS NULL
     OR p_bookings IS NULL
     OR pg_catalog.jsonb_typeof(p_bookings) <> 'array'
     OR length(v_digits) < 7
     OR (
       nullif(trim(coalesce(p_client_email, '')), '') IS NOT NULL
       AND (
         length(trim(p_client_email)) > 254
         OR trim(p_client_email)
              !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
       )
     ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_input');
  END IF;

  v_group_size := pg_catalog.jsonb_array_length(p_bookings);
  IF v_group_size < 2 OR v_group_size > 20 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_group_size');
  END IF;

  SELECT
    coalesce(nullif(trim(s.currency_code), ''), 'USD'),
    s.tax_lines
  INTO v_currency, v_tax_lines
  FROM public.salons s
  WHERE s.id = p_salon_id;

  IF NOT FOUND
     OR v_tax_lines IS NULL
     OR pg_catalog.jsonb_typeof(v_tax_lines) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'code', 'pricing_config_invalid');
  END IF;

  FOR v_booking, v_ord IN
    SELECT e.value, e.ordinality::integer
    FROM pg_catalog.jsonb_array_elements(p_bookings)
      WITH ORDINALITY AS e(value, ordinality)
    ORDER BY e.ordinality
  LOOP
    v_member_index := v_ord - 1;
    IF pg_catalog.jsonb_typeof(v_booking) <> 'object'
       OR (
         v_booking - ARRAY[
           'service_id', 'staff_id', 'start_time_utc', 'end_time_utc',
           'addon_service_ids', 'client_name', 'client_phone', 'client_email',
           'client_notes', 'staff_requested_by_client', 'wave_number',
           'seat_together', 'client_locale', 'resource_id'
         ]::text[]
       ) <> '{}'::jsonb
       OR length(trim(coalesce(v_booking->>'client_name', ''))) NOT BETWEEN 1 AND 100
       OR trim(v_booking->>'client_name') ~ '[<>{}=&;]' THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_data');
    END IF;

    BEGIN
      v_service_id := (v_booking->>'service_id')::uuid;
      v_staff_id := (v_booking->>'staff_id')::uuid;
      v_start := (v_booking->>'start_time_utc')::timestamptz;
      v_end := (v_booking->>'end_time_utc')::timestamptz;
      v_resource_id := nullif(v_booking->>'resource_id', '')::uuid;
      v_staff_requested := coalesce(
        (v_booking->>'staff_requested_by_client')::boolean,
        false
      );
      v_wave := coalesce((v_booking->>'wave_number')::smallint, 1);
      v_seat_together := coalesce(
        (v_booking->>'seat_together')::boolean,
        false
      );

      IF v_booking->'addon_service_ids' IS NULL THEN
        v_addon_ids := ARRAY[]::uuid[];
      ELSIF pg_catalog.jsonb_typeof(v_booking->'addon_service_ids') = 'array' THEN
        SELECT coalesce(
          array_agg(a.value::uuid ORDER BY a.ordinality),
          ARRAY[]::uuid[]
        )
        INTO v_addon_ids
        FROM pg_catalog.jsonb_array_elements_text(
          v_booking->'addon_service_ids'
        ) WITH ORDINALITY AS a(value, ordinality);
      ELSE
        RETURN jsonb_build_object('success', false, 'code', 'invalid_addon');
      END IF;
    EXCEPTION
      WHEN invalid_text_representation
        OR invalid_datetime_format
        OR datetime_field_overflow
        OR numeric_value_out_of_range THEN
        RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_data');
    END;

    IF v_wave < 1 OR v_wave > v_group_size THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_data');
    END IF;

    IF v_resource_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.salon_resources r
      WHERE r.id = v_resource_id
        AND r.salon_id = p_salon_id
        AND r.status = 'active'
        AND r.deleted_at IS NULL
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_resource');
    END IF;

    v_member_phone := CASE
      WHEN v_member_index = 0 THEN v_digits
      ELSE pg_catalog.regexp_replace(
        coalesce(v_booking->>'client_phone', ''), '\D', '', 'g'
      )
    END;
    IF length(v_member_phone) < 7 THEN
      v_member_phone := NULL;
    END IF;
    v_member_email := CASE
      WHEN v_member_index = 0
        THEN nullif(lower(trim(coalesce(p_client_email, ''))), '')
      ELSE nullif(lower(trim(coalesce(v_booking->>'client_email', ''))), '')
    END;
    IF v_member_email IS NOT NULL AND (
      length(v_member_email) > 254
      OR v_member_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'invalid_booking_data');
    END IF;

    v_quote := public.resolve_public_booking_pricing(
      p_salon_id,
      v_service_id,
      v_staff_id,
      v_start,
      v_end,
      v_addon_ids,
      NULL,
      NULL,
      v_digits,
      NULL,
      false,
      false
    );
    IF coalesce(v_quote->>'success', 'false') <> 'true' THEN
      RETURN v_quote;
    END IF;
    IF v_quote->>'currency' IS DISTINCT FROM v_currency THEN
      RETURN jsonb_build_object('success', false, 'code', 'pricing_config_invalid');
    END IF;

    -- Quote availability is advisory; exclusion constraints repeat this check
    -- atomically during create and close every read/write race.
    IF EXISTS (
      SELECT 1
      FROM public.bookings b
      WHERE b.salon_id = p_salon_id
        AND b.staff_id = v_staff_id
        AND b.status NOT IN ('cancelled', 'no_show', 'completed')
        AND pg_catalog.tstzrange(
          b.start_time_utc, b.end_time_utc, '[)'
        ) && pg_catalog.tstzrange(v_start, v_end, '[)')
    ) OR (
      v_resource_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.bookings b
        WHERE b.salon_id = p_salon_id
          AND b.resource_id = v_resource_id
          AND b.status NOT IN ('cancelled', 'no_show')
          AND pg_catalog.tstzrange(
            b.start_time_utc, b.end_time_utc, '[)'
          ) && pg_catalog.tstzrange(v_start, v_end, '[)')
      )
    ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'slot_conflict');
    END IF;

    v_normalized := v_normalized || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'member_index', v_member_index,
        'service_id', v_service_id,
        'staff_id', v_staff_id,
        'start_time_utc', v_start,
        'end_time_utc', v_end,
        'addon_service_ids', pg_catalog.to_jsonb(v_addon_ids),
        'client_name', trim(v_booking->>'client_name'),
        'client_phone', v_member_phone,
        'client_email', v_member_email,
        'client_notes', nullif(left(trim(coalesce(v_booking->>'client_notes', '')), 500), ''),
        'staff_requested_by_client', v_staff_requested,
        'wave_number', v_wave,
        'seat_together', v_seat_together,
        'client_locale', nullif(trim(coalesce(v_booking->>'client_locale', '')), ''),
        'resource_id', v_resource_id
      )
    );

    v_base_members := v_base_members || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'member_index', v_member_index,
        'service_id', v_service_id,
        'staff_id', v_staff_id,
        'start_time_utc', v_start,
        'end_time_utc', v_end,
        'addon_service_ids', v_quote->'addon_service_ids',
        'addon_lines', v_quote->'addon_lines',
        'first_addon_id', v_quote->'first_addon_id',
        'trailing_buffer_minutes', (v_quote->>'trailing_buffer_minutes')::integer,
        'promo_id', v_quote->'promo_id',
        'promo_name', v_quote->'promo_name',
        'original_price_cents', (v_quote->>'original_price_cents')::integer,
        'service_pre_voucher_cents', (v_quote->>'service_pre_voucher_cents')::integer,
        'addon_pre_voucher_cents', (v_quote->>'addon_pre_voucher_cents')::integer,
        'promo_discount_cents', (v_quote->>'promo_discount_cents')::integer
      )
    );
  END LOOP;

  -- Reject overlapping assignments inside the requested party itself.
  FOR v_left IN
    SELECT value FROM pg_catalog.jsonb_array_elements(v_normalized)
  LOOP
    FOR v_right IN
      SELECT value FROM pg_catalog.jsonb_array_elements(v_normalized)
    LOOP
      IF (v_right->>'member_index')::integer <=
           (v_left->>'member_index')::integer THEN
        CONTINUE;
      END IF;
      IF (
        v_left->>'staff_id' = v_right->>'staff_id'
        OR (
          nullif(v_left->>'resource_id', '') IS NOT NULL
          AND v_left->>'resource_id' = v_right->>'resource_id'
        )
      ) AND pg_catalog.tstzrange(
        (v_left->>'start_time_utc')::timestamptz,
        (v_left->>'end_time_utc')::timestamptz,
        '[)'
      ) && pg_catalog.tstzrange(
        (v_right->>'start_time_utc')::timestamptz,
        (v_right->>'end_time_utc')::timestamptz,
        '[)'
      ) THEN
        RETURN jsonb_build_object('success', false, 'code', 'slot_conflict');
      END IF;
    END LOOP;
  END LOOP;

  -- All client/profile locks precede the voucher lock. Sorted advisory locks
  -- also serialize the missing-profile case, for which FOR UPDATE has no row.
  IF p_lock_claims THEN
    FOR v_member_phone IN
      SELECT DISTINCT n.value->>'client_phone'
      FROM pg_catalog.jsonb_array_elements(v_normalized) n(value)
      WHERE length(coalesce(n.value->>'client_phone', '')) >= 7
      ORDER BY n.value->>'client_phone'
    LOOP
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'public-booking-client:' || v_member_phone,
          0
        )
      );
    END LOOP;

    PERFORM cp.id
    FROM public.client_profiles cp
    WHERE cp.phone IN (
      SELECT DISTINCT n.value->>'client_phone'
      FROM pg_catalog.jsonb_array_elements(v_normalized) n(value)
      WHERE length(coalesce(n.value->>'client_phone', '')) >= 7
    )
    ORDER BY cp.phone
    FOR UPDATE;
  END IF;

  SELECT cp.id, cp.email_discount_claimed_at
  INTO v_profile_id, v_email_claimed_at
  FROM public.client_profiles cp
  WHERE cp.phone = v_digits;

  IF p_apply_email_discount IS TRUE
     AND nullif(trim(coalesce(p_client_email, '')), '') IS NOT NULL
     AND (v_profile_id IS NULL OR v_email_claimed_at IS NULL) THEN
    v_group_email := least(
      200,
      (v_base_members->0->>'service_pre_voucher_cents')::integer
    );
  END IF;

  FOR v_member IN
    SELECT value
    FROM pg_catalog.jsonb_array_elements(v_base_members)
    ORDER BY (value->>'member_index')::integer
  LOOP
    v_email_alloc := CASE
      WHEN (v_member->>'member_index')::integer = 0 THEN v_group_email
      ELSE 0
    END;
    v_service_pre := (v_member->>'service_pre_voucher_cents')::integer;
    v_addon_pre := (v_member->>'addon_pre_voucher_cents')::integer;
    -- Member original_price_cents is intentionally service-only, matching the
    -- individual pricing contract. Add-ons remain explicit in addon_* fields.
    v_group_original := v_group_original
      + (v_member->>'original_price_cents')::integer;
    v_group_promo := v_group_promo
      + (v_member->>'promo_discount_cents')::integer;
    v_group_pre_voucher := v_group_pre_voucher
      + greatest(0, v_service_pre - v_email_alloc) + v_addon_pre;
  END LOOP;

  IF p_voucher_id IS NOT NULL THEN
    IF p_lock_claims THEN
      SELECT v.* INTO v_voucher
      FROM public.vouchers v
      WHERE v.id = p_voucher_id
      FOR UPDATE;
    ELSE
      SELECT v.* INTO v_voucher
      FROM public.vouchers v
      WHERE v.id = p_voucher_id;
    END IF;

    -- V1 supports only unrestricted whole-party percent/amount vouchers.
    -- Identity/service/category restrictions and free-service vouchers remain
    -- on the legacy/BETA path until a separate product policy is approved.
    IF NOT FOUND
       OR v_voucher.salon_id <> p_salon_id
       OR v_voucher.revoked_at IS NOT NULL
       OR transaction_timestamp() < v_voucher.valid_from
       OR transaction_timestamp() > v_voucher.expires_at
       OR v_voucher.used_count >= v_voucher.max_uses
       OR v_voucher.client_phone IS NOT NULL
       OR v_voucher.client_profile_id IS NOT NULL
       OR coalesce(pg_catalog.cardinality(v_voucher.applicable_service_ids), 0) > 0
       OR v_voucher.applicable_service_category IS NOT NULL
       OR v_voucher.free_service_id IS NOT NULL
       OR coalesce(v_voucher.min_spend_cents, 0) > v_group_pre_voucher
       OR (
         (v_voucher.percent_off IS NULL) =
         (v_voucher.amount_off_cents IS NULL)
       ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'voucher_invalid');
    END IF;

    IF v_voucher.percent_off IS NOT NULL THEN
      v_group_voucher := floor(
        v_group_pre_voucher::numeric * v_voucher.percent_off::numeric / 100
      )::integer;
    ELSE
      v_group_voucher := least(
        v_voucher.amount_off_cents,
        v_group_pre_voucher
      );
    END IF;
    v_group_voucher := greatest(
      0,
      least(v_group_voucher, v_group_pre_voucher)
    );
    IF v_group_voucher < 1 THEN
      RETURN jsonb_build_object('success', false, 'code', 'voucher_invalid');
    END IF;
  END IF;

  v_remaining_voucher := v_group_voucher;
  FOR v_member IN
    SELECT value
    FROM pg_catalog.jsonb_array_elements(v_base_members)
    ORDER BY (value->>'member_index')::integer
  LOOP
    v_member_index := (v_member->>'member_index')::integer;
    v_member_original := (v_member->>'original_price_cents')::integer;
    v_service_pre := (v_member->>'service_pre_voucher_cents')::integer;
    v_addon_pre := (v_member->>'addon_pre_voucher_cents')::integer;
    v_email_alloc := CASE WHEN v_member_index = 0 THEN v_group_email ELSE 0 END;
    v_service_pre := greatest(0, v_service_pre - v_email_alloc);
    v_member_pre_voucher := v_service_pre + v_addon_pre;

    -- Deterministic organizer-first waterfall. It cannot lose cents and never
    -- assigns more discount than the member's own pre-voucher subtotal.
    v_voucher_alloc := least(v_member_pre_voucher, v_remaining_voucher);
    v_remaining_voucher := v_remaining_voucher - v_voucher_alloc;
    v_final_service := v_service_pre;
    v_final_addon := v_addon_pre;
    IF v_voucher_alloc <= v_final_service THEN
      v_final_service := v_final_service - v_voucher_alloc;
    ELSE
      v_final_addon := greatest(
        0,
        v_final_addon - (v_voucher_alloc - v_final_service)
      );
      v_final_service := 0;
    END IF;
    v_member_subtotal := v_final_service + v_final_addon;

    -- Tax is allocated after all member subtotals are known. Initial member
    -- rows therefore carry zero tax; each enabled group tax line is rounded
    -- once at party level and distributed with largest remainder below.
    v_member_tax := 0;
    v_member_tax_breakdown := '[]'::jsonb;
    v_member_total := v_member_subtotal;
    v_group_subtotal := v_group_subtotal + v_member_subtotal;

    v_final_members := v_final_members || pg_catalog.jsonb_build_array(
      v_member || pg_catalog.jsonb_build_object(
        'original_price_cents', v_member_original,
        'service_pre_voucher_cents', v_service_pre,
        'addon_pre_voucher_cents', v_addon_pre,
        'email_discount_cents', v_email_alloc,
        'voucher_discount_cents', v_voucher_alloc,
        'price_cents', v_final_service,
        'addon_price_cents', v_final_addon,
        'pre_voucher_subtotal_cents', v_member_pre_voucher,
        'subtotal_cents', v_member_subtotal,
        'tax_cents', v_member_tax,
        'tax_amount_cents', v_member_tax,
        'total_cents', v_member_total,
        'tax_breakdown', v_member_tax_breakdown
      )
    );
  END LOOP;

  IF v_remaining_voucher <> 0
     OR v_group_subtotal <> v_group_pre_voucher - v_group_voucher THEN
    RAISE EXCEPTION 'group pricing allocation invariant failed';
  END IF;

  -- Round each tax line once at group level, then allocate cents across the
  -- member rows by largest remainder. Stable member_index is the tie-breaker.
  -- This guarantees member lines sum to round(group_subtotal * rate), avoiding
  -- the penny drift produced by independently rounding every member.
  FOR v_tax_line IN
    SELECT value FROM pg_catalog.jsonb_array_elements(v_tax_lines)
  LOOP
    IF pg_catalog.jsonb_typeof(v_tax_line) <> 'object'
       OR v_tax_line->'name' IS NULL
       OR pg_catalog.jsonb_typeof(v_tax_line->'name') <> 'string'
       OR nullif(trim(v_tax_line->>'name'), '') IS NULL
       OR v_tax_line->'rate' IS NULL
       OR pg_catalog.jsonb_typeof(v_tax_line->'rate') <> 'number'
       OR (
         v_tax_line->'enabled' IS NOT NULL
         AND pg_catalog.jsonb_typeof(v_tax_line->'enabled') <> 'boolean'
       ) THEN
      RETURN jsonb_build_object('success', false, 'code', 'pricing_config_invalid');
    END IF;
    v_tax_rate := (v_tax_line->>'rate')::numeric;
    v_tax_enabled := coalesce((v_tax_line->>'enabled')::boolean, true);
    IF v_tax_rate < 0 OR v_tax_rate > 1 THEN
      RETURN jsonb_build_object('success', false, 'code', 'pricing_config_invalid');
    END IF;
    IF v_tax_enabled AND v_tax_rate > 0 THEN
      v_group_tax_line_amount := round(
        v_group_subtotal::numeric * v_tax_rate
      )::integer;

      SELECT coalesce(sum(floor(
        (m.value->>'subtotal_cents')::numeric * v_tax_rate
      )), 0)::integer
      INTO v_tax_floor_sum
      FROM pg_catalog.jsonb_array_elements(v_final_members) m(value);
      v_tax_remainder_count := v_group_tax_line_amount - v_tax_floor_sum;
      IF v_tax_remainder_count < 0 OR v_tax_remainder_count > v_group_size THEN
        RAISE EXCEPTION 'group tax allocation invariant failed';
      END IF;

      WITH shares AS (
        SELECT
          m.value,
          (m.value->>'member_index')::integer AS member_index,
          floor(
            (m.value->>'subtotal_cents')::numeric * v_tax_rate
          )::integer AS floor_cents,
          (
            (m.value->>'subtotal_cents')::numeric * v_tax_rate
            - floor((m.value->>'subtotal_cents')::numeric * v_tax_rate)
          ) AS remainder,
          row_number() OVER (
            ORDER BY
              (
                (m.value->>'subtotal_cents')::numeric * v_tax_rate
                - floor((m.value->>'subtotal_cents')::numeric * v_tax_rate)
              ) DESC,
              (m.value->>'member_index')::integer
          ) AS remainder_rank
        FROM pg_catalog.jsonb_array_elements(v_final_members) m(value)
      ), allocated AS (
        SELECT
          value,
          member_index,
          floor_cents + CASE
            WHEN remainder_rank <= v_tax_remainder_count THEN 1 ELSE 0
          END AS amount_cents
        FROM shares
      )
      SELECT coalesce(
        pg_catalog.jsonb_agg(
          a.value || pg_catalog.jsonb_build_object(
            'tax_cents', (a.value->>'tax_cents')::integer + a.amount_cents,
            'tax_amount_cents',
              (a.value->>'tax_amount_cents')::integer + a.amount_cents,
            'total_cents', (a.value->>'total_cents')::integer + a.amount_cents,
            'tax_breakdown', a.value->'tax_breakdown' ||
              pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object(
                  'name', trim(v_tax_line->>'name'),
                  'rate', v_tax_rate,
                  'amount_cents', a.amount_cents
                )
              )
          )
          ORDER BY a.member_index
        ),
        '[]'::jsonb
      )
      INTO v_final_members
      FROM allocated a;

      v_group_tax := v_group_tax + v_group_tax_line_amount;

      v_tax_breakdown := v_tax_breakdown || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'name', trim(v_tax_line->>'name'),
          'rate', v_tax_rate,
          'amount_cents', v_group_tax_line_amount
        )
      );
    END IF;
  END LOOP;

  v_group_total := v_group_subtotal + v_group_tax;
  v_material := pg_catalog.jsonb_build_object(
    'salon_id', p_salon_id,
    'group_size', v_group_size,
    'currency', v_currency,
    'voucher_id', p_voucher_id,
    'original_price_cents', v_group_original,
    'promo_discount_cents', v_group_promo,
    'email_discount_cents', v_group_email,
    'voucher_discount_cents', v_group_voucher,
    'pre_voucher_subtotal_cents', v_group_pre_voucher,
    'subtotal_cents', v_group_subtotal,
    'tax_cents', v_group_tax,
    'tax_amount_cents', v_group_tax,
    'total_cents', v_group_total,
    'tax_breakdown', v_tax_breakdown,
    'member_quotes', v_final_members
  );
  v_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_material::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'code', 'quoted',
    'pricing_fingerprint', v_fingerprint
  ) || v_material;
END;
$group_pricing$;

REVOKE ALL ON FUNCTION public.resolve_group_booking_pricing(
  uuid, jsonb, uuid, text, text, boolean, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_group_booking_pricing(
  uuid, jsonb, uuid, text, text, boolean, boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.quote_group_booking(
  p_salon_id uuid,
  p_bookings jsonb,
  p_voucher_id uuid,
  p_client_phone text,
  p_client_email text,
  p_apply_email_discount boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $group_quote$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  RETURN public.resolve_group_booking_pricing(
    p_salon_id,
    p_bookings,
    p_voucher_id,
    p_client_phone,
    p_client_email,
    p_apply_email_discount,
    false
  );
END;
$group_quote$;

REVOKE ALL ON FUNCTION public.quote_group_booking(
  uuid, jsonb, uuid, text, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_group_booking(
  uuid, jsonb, uuid, text, text, boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.create_group_bookings(
  p_salon_id uuid,
  p_bookings jsonb,
  p_voucher_id uuid,
  p_client_phone text,
  p_client_email text,
  p_apply_email_discount boolean,
  p_group_idempotency_key uuid,
  p_expected_pricing_fingerprint text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $group_create$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_digits text := pg_catalog.regexp_replace(
    coalesce(p_client_phone, ''), '\D', '', 'g'
  );
  v_request_material jsonb;
  v_request_fingerprint text;
  v_existing public.bookings%ROWTYPE;
  v_quote jsonb;
  v_quote_fingerprint text;
  v_group_id uuid := extensions.gen_random_uuid();
  v_booking_ids uuid[] := ARRAY[]::uuid[];
  v_booking_id uuid;
  v_group_size integer;
  v_effective_plan text;
  v_feature_flags jsonb;
  v_month_booking_count bigint;
  v_month_start_utc timestamptz := (
    pg_catalog.date_trunc(
      'month',
      transaction_timestamp() AT TIME ZONE 'UTC'
    ) AT TIME ZONE 'UTC'
  );
  v_member jsonb;
  v_input jsonb;
  v_addon jsonb;
  v_member_index integer;
  v_member_phone text;
  v_member_email text;
  v_profile_id uuid;
  v_organizer_booking_id uuid;
  v_persisted_snapshot jsonb;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_group_idempotency_key IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'missing_idempotency_key'
    );
  END IF;
  IF p_expected_pricing_fingerprint IS NULL
     OR p_expected_pricing_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'missing_pricing_fingerprint'
    );
  END IF;

  v_request_material := pg_catalog.jsonb_build_object(
    'salon_id', p_salon_id,
    'bookings', p_bookings,
    'voucher_id', p_voucher_id,
    'client_phone', v_digits,
    'client_email', nullif(lower(trim(coalesce(p_client_email, ''))), ''),
    'apply_email_discount', coalesce(p_apply_email_discount, false),
    'expected_pricing_fingerprint', p_expected_pricing_fingerprint
  );
  v_request_fingerprint := pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(v_request_material::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-booking-idempotency:' ||
      coalesce(p_salon_id::text, 'missing') || ':' ||
      p_group_idempotency_key::text,
      0
    )
  );

  SELECT b.* INTO v_existing
  FROM public.bookings b
  WHERE b.salon_id = p_salon_id
    AND b.idempotency_key = p_group_idempotency_key
    AND b.group_id IS NOT NULL
    AND b.is_group_organizer IS TRUE;

  IF FOUND THEN
    IF v_existing.public_booking_request_fingerprint
         IS DISTINCT FROM v_request_fingerprint
       OR v_existing.public_booking_pricing_fingerprint
         IS DISTINCT FROM p_expected_pricing_fingerprint
       OR pg_catalog.jsonb_typeof(v_existing.public_booking_pricing_snapshot)
         IS DISTINCT FROM 'object'
       OR v_existing.public_booking_pricing_snapshot->>'group_id'
         IS DISTINCT FROM v_existing.group_id::text
       OR pg_catalog.jsonb_typeof(
         v_existing.public_booking_pricing_snapshot->'booking_ids'
       ) IS DISTINCT FROM 'array' THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'idempotency_conflict'
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

  v_quote := public.resolve_group_booking_pricing(
    p_salon_id,
    p_bookings,
    p_voucher_id,
    p_client_phone,
    p_client_email,
    p_apply_email_discount,
    true
  );
  IF coalesce(v_quote->>'success', 'false') <> 'true' THEN
    RETURN v_quote;
  END IF;
  v_quote_fingerprint := v_quote->>'pricing_fingerprint';
  IF v_quote_fingerprint IS DISTINCT FROM p_expected_pricing_fingerprint THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'pricing_changed',
      'quote', v_quote
    );
  END IF;

  v_group_size := (v_quote->>'group_size')::integer;

  -- Serialize group-cap decisions on the salon row. Exact replay above never
  -- re-consumes quota. Free/default plans permit at most 50 non-cancelled
  -- booking rows in the current UTC service month; Pro/Premium and the
  -- explicit unlimited_bookings control-plane flag remain unlimited.
  SELECT
    CASE
      WHEN s.plan_override IN ('free', 'pro', 'premium') THEN s.plan_override
      WHEN s.subscription_plan IN ('free', 'pro', 'premium')
        THEN s.subscription_plan
      ELSE 'free'
    END,
    coalesce(s.feature_flags, '{}'::jsonb)
  INTO v_effective_plan, v_feature_flags
  FROM public.salons s
  WHERE s.id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_reference');
  END IF;

  IF v_effective_plan = 'free'
     AND coalesce(v_feature_flags->>'unlimited_bookings', 'false') <> 'true' THEN
    SELECT count(*)
    INTO v_month_booking_count
    FROM public.bookings b
    WHERE b.salon_id = p_salon_id
      AND b.start_time_utc >= v_month_start_utc
      AND b.start_time_utc < v_month_start_utc + interval '1 month'
      AND b.status <> 'cancelled';
    IF v_month_booking_count + v_group_size > 50 THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'monthly_booking_limit_reached'
      );
    END IF;
  END IF;

  BEGIN
    FOR v_member IN
      SELECT value
      FROM pg_catalog.jsonb_array_elements(v_quote->'member_quotes')
      ORDER BY (value->>'member_index')::integer
    LOOP
      v_member_index := (v_member->>'member_index')::integer;
      v_input := p_bookings->v_member_index;
      v_member_phone := CASE
        WHEN v_member_index = 0 THEN v_digits
        ELSE pg_catalog.regexp_replace(
          coalesce(v_input->>'client_phone', ''), '\D', '', 'g'
        )
      END;
      IF length(v_member_phone) < 7 THEN
        v_member_phone := NULL;
      END IF;
      v_member_email := CASE
        WHEN v_member_index = 0
          THEN nullif(lower(trim(coalesce(p_client_email, ''))), '')
        ELSE nullif(lower(trim(coalesce(v_input->>'client_email', ''))), '')
      END;

      v_profile_id := NULL;
      IF v_member_phone IS NOT NULL THEN
        v_profile_id := public.resolve_client_profile(
          v_member_phone,
          trim(v_input->>'client_name'),
          v_member_email,
          (v_member->>'staff_id')::uuid
        );
      END IF;

      INSERT INTO public.bookings (
        salon_id,
        service_id,
        staff_id,
        client_name,
        client_phone,
        client_email,
        client_notes,
        start_time_utc,
        end_time_utc,
        status,
        confirmed_at,
        price_cents,
        addon_service_id,
        addon_price_cents,
        promo_id,
        original_price_cents,
        subtotal_cents,
        tax_amount_cents,
        staff_requested_by_client,
        group_id,
        group_size,
        wave_number,
        seat_together,
        idempotency_key,
        client_locale,
        is_party_member,
        is_group_organizer,
        client_profile_id,
        resource_id,
        public_booking_request_fingerprint,
        public_booking_pricing_fingerprint,
        public_booking_pricing_snapshot
      ) VALUES (
        p_salon_id,
        (v_member->>'service_id')::uuid,
        (v_member->>'staff_id')::uuid,
        trim(v_input->>'client_name'),
        v_member_phone,
        v_member_email,
        nullif(left(trim(coalesce(v_input->>'client_notes', '')), 500), ''),
        (v_member->>'start_time_utc')::timestamptz,
        (v_member->>'end_time_utc')::timestamptz,
        'confirmed',
        transaction_timestamp(),
        (v_member->>'price_cents')::integer,
        nullif(v_member->>'first_addon_id', '')::uuid,
        CASE
          WHEN pg_catalog.jsonb_array_length(v_member->'addon_service_ids') > 0
            THEN (v_member->>'addon_price_cents')::integer
          ELSE NULL
        END,
        nullif(v_member->>'promo_id', '')::uuid,
        (v_member->>'original_price_cents')::integer,
        (v_member->>'subtotal_cents')::integer,
        (v_member->>'tax_cents')::integer,
        coalesce((v_input->>'staff_requested_by_client')::boolean, false),
        v_group_id,
        v_group_size,
        coalesce((v_input->>'wave_number')::smallint, 1),
        coalesce((v_input->>'seat_together')::boolean, false),
        CASE WHEN v_member_index = 0 THEN p_group_idempotency_key ELSE NULL END,
        nullif(trim(coalesce(v_input->>'client_locale', '')), ''),
        v_profile_id IS NULL,
        v_member_index = 0,
        v_profile_id,
        nullif(v_input->>'resource_id', '')::uuid,
        CASE WHEN v_member_index = 0 THEN v_request_fingerprint ELSE NULL END,
        v_quote_fingerprint,
        v_member || pg_catalog.jsonb_build_object(
          'pricing_fingerprint', v_quote_fingerprint
        )
      )
      RETURNING id INTO v_booking_id;

      v_booking_ids := pg_catalog.array_append(v_booking_ids, v_booking_id);
      IF v_member_index = 0 THEN
        v_organizer_booking_id := v_booking_id;
      END IF;

      FOR v_addon IN
        SELECT value
        FROM pg_catalog.jsonb_array_elements(v_member->'addon_lines')
      LOOP
        INSERT INTO public.booking_addons (
          booking_id,
          service_id,
          name,
          price_cents,
          duration_minutes
        ) VALUES (
          v_booking_id,
          (v_addon->>'service_id')::uuid,
          v_addon->>'name',
          (v_addon->>'price_cents')::integer,
          (v_addon->>'duration_minutes')::integer
        );
      END LOOP;
    END LOOP;

    IF pg_catalog.cardinality(v_booking_ids) <> v_group_size
       OR v_organizer_booking_id IS NULL THEN
      RAISE EXCEPTION 'group booking member count invariant failed';
    END IF;

    IF (v_quote->>'email_discount_cents')::integer > 0 THEN
      UPDATE public.client_profiles cp
      SET email_discount_claimed_at = transaction_timestamp(),
          updated_at = transaction_timestamp()
      FROM public.bookings b
      WHERE b.id = v_organizer_booking_id
        AND b.client_profile_id = cp.id
        AND cp.phone = v_digits
        AND cp.email_discount_claimed_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'group email discount claim not persisted';
      END IF;
    END IF;

    IF p_voucher_id IS NOT NULL THEN
      INSERT INTO public.voucher_redemptions (
        voucher_id,
        salon_id,
        booking_id,
        client_phone,
        discount_applied_cents,
        original_price_cents,
        final_price_cents
      ) VALUES (
        p_voucher_id,
        p_salon_id,
        v_organizer_booking_id,
        v_digits,
        (v_quote->>'voucher_discount_cents')::integer,
        (v_quote->>'pre_voucher_subtotal_cents')::integer,
        (v_quote->>'subtotal_cents')::integer
      );
    END IF;

    v_persisted_snapshot := v_quote || pg_catalog.jsonb_build_object(
      'group_id', v_group_id,
      'booking_ids', pg_catalog.to_jsonb(v_booking_ids)
    );
    UPDATE public.bookings b
    SET public_booking_pricing_snapshot = v_persisted_snapshot
    WHERE b.id = v_organizer_booking_id
      AND b.salon_id = p_salon_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'group organizer pricing snapshot not persisted';
    END IF;

    RETURN v_persisted_snapshot || pg_catalog.jsonb_build_object(
      'success', true,
      'code', 'booked',
      'idempotent', false,
      'pricing_snapshot', v_persisted_snapshot
    );
  EXCEPTION
    WHEN exclusion_violation THEN
      RETURN jsonb_build_object('success', false, 'code', 'slot_conflict');
    WHEN unique_violation THEN
      RETURN jsonb_build_object('success', false, 'code', 'duplicate_submission');
  END;
END;
$group_create$;

REVOKE ALL ON FUNCTION public.create_group_bookings(
  uuid, jsonb, uuid, text, text, boolean, uuid, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_group_bookings(
  uuid, jsonb, uuid, text, text, boolean, uuid, text
) TO service_role;

COMMENT ON FUNCTION public.resolve_group_booking_pricing(
  uuid, jsonb, uuid, text, text, boolean, boolean
) IS
  'Service-only shared Group/Party pricing resolver. No booking, add-on, redemption, notification, or provider write occurs here.';
COMMENT ON FUNCTION public.quote_group_booking(
  uuid, jsonb, uuid, text, text, boolean
) IS
  'Service-only authoritative Group/Party quote wrapper. App/API owns same-origin, identity, and abuse gates.';
COMMENT ON FUNCTION public.create_group_bookings(
  uuid, jsonb, uuid, text, text, boolean, uuid, text
) IS
  'Service-only atomic Group/Party create. Exact replay precedes quota/availability checks; new free-plan groups enforce the monthly row cap before persisting all bookings, add-ons, pricing evidence, one organizer incentive claim, and one whole-party voucher redemption.';

DO $group_contract_proof$
DECLARE
  v_resolver regprocedure := pg_catalog.to_regprocedure(
    'public.resolve_group_booking_pricing(uuid,jsonb,uuid,text,text,boolean,boolean)'
  );
  v_quote regprocedure := pg_catalog.to_regprocedure(
    'public.quote_group_booking(uuid,jsonb,uuid,text,text,boolean)'
  );
  v_create regprocedure := pg_catalog.to_regprocedure(
    'public.create_group_bookings(uuid,jsonb,uuid,text,text,boolean,uuid,text)'
  );
  v_legacy regprocedure := pg_catalog.to_regprocedure(
    'public.insert_group_bookings(jsonb)'
  );
  v_target regprocedure;
  v_def text;
BEGIN
  IF v_resolver IS NULL OR v_quote IS NULL OR v_create IS NULL OR v_legacy IS NULL THEN
    RAISE EXCEPTION 'group pricing contract signature missing';
  END IF;

  FOREACH v_target IN ARRAY ARRAY[v_resolver, v_quote, v_create]
  LOOP
    IF pg_catalog.has_function_privilege('anon', v_target, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_target, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_target, 'EXECUTE')
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc p
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
         ) acl
         WHERE p.oid = v_target::oid
           AND acl.grantee = 0
           AND acl.privilege_type = 'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'group pricing ACL mismatch: %', v_target;
    END IF;
    SELECT pg_catalog.pg_get_functiondef(v_target::oid) INTO v_def;
    IF position('SECURITY DEFINER' IN v_def) = 0
       OR position('SET search_path TO ''''' IN v_def) = 0 THEN
      RAISE EXCEPTION 'group pricing hardening mismatch: %', v_target;
    END IF;
  END LOOP;

  -- Legacy body remains callable only from scoped service-role paths.
  IF pg_catalog.has_function_privilege('anon', v_legacy, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_legacy, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_legacy, 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc p
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
       ) acl
       WHERE p.oid = v_legacy::oid
         AND acl.grantee = 0
         AND acl.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'legacy group booking service-only grant drift';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index i
    WHERE i.indexrelid = 'public.idx_bookings_group_idempotency_once'::regclass
      AND i.indrelid = 'public.bookings'::regclass
      AND i.indisunique
      AND i.indisvalid
      AND i.indnkeyatts = 2
      AND i.indkey::text = pg_catalog.format(
        '%s %s',
        (SELECT a.attnum FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = 'public.bookings'::regclass
           AND a.attname = 'salon_id'),
        (SELECT a.attnum FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = 'public.bookings'::regclass
           AND a.attname = 'idempotency_key')
      )
      AND pg_catalog.pg_get_expr(i.indpred, i.indrelid) =
        '((idempotency_key IS NOT NULL) AND (group_id IS NOT NULL) AND (is_group_organizer IS TRUE))'
  ) THEN
    RAISE EXCEPTION 'group organizer idempotency index mismatch';
  END IF;

END;
$group_contract_proof$;
