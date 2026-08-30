-- One guest may receive two full services at once only when both the service
-- pair and the physical resource have been explicitly certified by the salon.
-- Everything defaults fail-closed; existing sequential schedules are unchanged.

ALTER TABLE public.salon_resources
  ADD COLUMN same_guest_parallel_capacity smallint NOT NULL DEFAULT 1;

ALTER TABLE public.salon_resources
  ADD CONSTRAINT salon_resources_same_guest_parallel_capacity_check
  CHECK (same_guest_parallel_capacity BETWEEN 1 AND 2);

COMMENT ON COLUMN public.salon_resources.same_guest_parallel_capacity IS
  'Maximum simultaneous full-service segments for one booking on this resource. Default 1; owners explicitly certify shared chairs/beds.';

CREATE TABLE public.service_parallel_policies (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  service_a_id uuid NOT NULL REFERENCES public.services(id) ON DELETE CASCADE,
  service_b_id uuid NOT NULL REFERENCES public.services(id) ON DELETE CASCADE,
  resource_mode text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  CONSTRAINT service_parallel_policies_distinct_services_check
    CHECK (service_a_id::text < service_b_id::text),
  CONSTRAINT service_parallel_policies_resource_mode_check
    CHECK (resource_mode IN ('shared', 'distinct', 'either')),
  CONSTRAINT service_parallel_policies_salon_pair_key
    UNIQUE (salon_id, service_a_id, service_b_id)
);

COMMENT ON TABLE public.service_parallel_policies IS
  'Salon-owned allowlist for two full services on one guest to overlap. Missing or inactive pair means sequential-only.';
COMMENT ON COLUMN public.service_parallel_policies.resource_mode IS
  'shared = same certified resource; distinct = separate resources; either = scheduler may use either arrangement.';

CREATE INDEX service_parallel_policies_service_a_idx
  ON public.service_parallel_policies (service_a_id);
CREATE INDEX service_parallel_policies_service_b_idx
  ON public.service_parallel_policies (service_b_id);

CREATE OR REPLACE FUNCTION public.enforce_service_parallel_policy_tenant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $parallel_policy_tenant$
DECLARE
  v_service_a_salon uuid;
  v_service_b_salon uuid;
BEGIN
  SELECT s.salon_id INTO v_service_a_salon
  FROM public.services s
  WHERE s.id = NEW.service_a_id
    AND s.deleted_at IS NULL
    AND s.is_addon IS FALSE;

  SELECT s.salon_id INTO v_service_b_salon
  FROM public.services s
  WHERE s.id = NEW.service_b_id
    AND s.deleted_at IS NULL
    AND s.is_addon IS FALSE;

  IF v_service_a_salon IS DISTINCT FROM NEW.salon_id
     OR v_service_b_salon IS DISTINCT FROM NEW.salon_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'parallel service policy tenant/reference mismatch';
  END IF;
  RETURN NEW;
END;
$parallel_policy_tenant$;

REVOKE ALL ON FUNCTION public.enforce_service_parallel_policy_tenant()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER enforce_service_parallel_policy_tenant
  BEFORE INSERT OR UPDATE OF salon_id, service_a_id, service_b_id
  ON public.service_parallel_policies
  FOR EACH ROW EXECUTE FUNCTION public.enforce_service_parallel_policy_tenant();

CREATE TRIGGER set_service_parallel_policies_updated_at
  BEFORE UPDATE ON public.service_parallel_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.service_parallel_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_parallel_policies FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.service_parallel_policies
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.service_parallel_policies TO service_role;

CREATE POLICY "owners manage service parallel policies"
  ON public.service_parallel_policies
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.salon_members member
      WHERE member.salon_id = service_parallel_policies.salon_id
        AND member.user_id = (SELECT auth.uid())
        AND member.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.salon_members member
      WHERE member.salon_id = service_parallel_policies.salon_id
        AND member.user_id = (SELECT auth.uid())
        AND member.role IN ('owner', 'admin')
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.service_parallel_policies TO authenticated;

-- Existing constraint rejects every same-resource overlap, including two
-- certified segments of the same atomic booking. Keep the database race barrier
-- for different bookings, then validate same-booking overlap with the policy
-- trigger below. btree_gist supports UUID <> for this exact exclusion shape.
ALTER TABLE public.booking_service_segments
  DROP CONSTRAINT booking_service_segments_resource_no_overlap;

ALTER TABLE public.booking_service_segments
  ADD CONSTRAINT booking_service_segments_resource_no_overlap
  EXCLUDE USING gist (
    salon_id WITH =,
    resource_id WITH =,
    booking_id WITH <>,
    pg_catalog.tstzrange(occupied_start_utc, occupied_end_utc, '[)') WITH &&
  ) WHERE (
    resource_id IS NOT NULL
    AND reservation_status NOT IN ('cancelled', 'no_show', 'completed')
  );

CREATE OR REPLACE FUNCTION public.enforce_parallel_segment_policy()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $parallel_segment_policy$
DECLARE
  v_prior public.booking_service_segments%ROWTYPE;
  v_policy_mode text;
  v_resource_capacity integer;
  v_same_resource_overlap_count integer;
  v_service_a uuid;
  v_service_b uuid;
BEGIN
  IF NEW.reservation_status IN ('cancelled', 'no_show', 'completed') THEN
    RETURN NEW;
  END IF;

  FOR v_prior IN
    SELECT seg.*
    FROM public.booking_service_segments seg
    WHERE seg.booking_id = NEW.booking_id
      AND seg.id IS DISTINCT FROM NEW.id
      AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
      -- Prep/trailing buffers may overlap inside an otherwise sequential
      -- booking. Parallel policy applies only when guest-facing service time
      -- overlaps; occupancy conflicts remain protected by the exclusions.
      AND pg_catalog.tstzrange(seg.customer_start_utc, seg.customer_end_utc, '[)')
        && pg_catalog.tstzrange(NEW.customer_start_utc, NEW.customer_end_utc, '[)')
    ORDER BY seg.position, seg.id
  LOOP
    IF v_prior.staff_id = NEW.staff_id THEN
      RAISE EXCEPTION USING ERRCODE = '23P01',
        MESSAGE = 'parallel services require distinct staff';
    END IF;

    v_service_a := CASE WHEN v_prior.service_id::text < NEW.service_id::text
      THEN v_prior.service_id ELSE NEW.service_id END;
    v_service_b := CASE WHEN v_prior.service_id::text < NEW.service_id::text
      THEN NEW.service_id ELSE v_prior.service_id END;

    SELECT p.resource_mode INTO v_policy_mode
    FROM public.service_parallel_policies p
    WHERE p.salon_id = NEW.salon_id
      AND p.service_a_id = v_service_a
      AND p.service_b_id = v_service_b
      AND p.active IS TRUE;

    IF v_policy_mode IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23P01',
        MESSAGE = 'parallel service pair is not allowed';
    END IF;

    IF NEW.resource_id IS NOT DISTINCT FROM v_prior.resource_id THEN
      IF NEW.resource_id IS NULL OR v_policy_mode NOT IN ('shared', 'either') THEN
        RAISE EXCEPTION USING ERRCODE = '23P01',
          MESSAGE = 'parallel service pair cannot share this resource';
      END IF;

      SELECT r.same_guest_parallel_capacity INTO v_resource_capacity
      FROM public.salon_resources r
      WHERE r.id = NEW.resource_id
        AND r.salon_id = NEW.salon_id
        AND r.status = 'active'
        AND r.deleted_at IS NULL
      FOR KEY SHARE;

      SELECT count(*) + 1 INTO v_same_resource_overlap_count
      FROM public.booking_service_segments seg
      WHERE seg.booking_id = NEW.booking_id
        AND seg.id IS DISTINCT FROM NEW.id
        AND seg.resource_id = NEW.resource_id
        AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
        AND pg_catalog.tstzrange(seg.customer_start_utc, seg.customer_end_utc, '[)')
          && pg_catalog.tstzrange(NEW.customer_start_utc, NEW.customer_end_utc, '[)');

      IF v_resource_capacity IS NULL
         OR v_same_resource_overlap_count > v_resource_capacity THEN
        RAISE EXCEPTION USING ERRCODE = '23P01',
          MESSAGE = 'shared resource parallel capacity exceeded';
      END IF;
    ELSIF v_policy_mode NOT IN ('distinct', 'either') THEN
      RAISE EXCEPTION USING ERRCODE = '23P01',
        MESSAGE = 'parallel service pair requires one shared resource';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$parallel_segment_policy$;

REVOKE ALL ON FUNCTION public.enforce_parallel_segment_policy()
  FROM PUBLIC, anon, authenticated;

CREATE TRIGGER enforce_parallel_segment_policy
  BEFORE INSERT OR UPDATE OF booking_id, salon_id, service_id, staff_id,
    resource_id, occupied_start_utc, occupied_end_utc, reservation_status
  ON public.booking_service_segments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_parallel_segment_policy();

-- Extend the canonical sequence engine; quote and commit continue to share the
-- same resolver and fingerprint, so a booking cannot partially commit.
CREATE OR REPLACE FUNCTION public.resolve_booking_sequence_pricing_and_schedule(
  p_request jsonb,
  p_lock_claims boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $sequence_resolver$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_salon_id uuid;
  v_request_id uuid;
  v_requested_start timestamptz;
  v_client_phone text;
  v_client_email text;
  v_apply_email boolean;
  v_same_staff boolean;
  v_voucher_id uuid;
  v_lines_input jsonb;
  v_line_input jsonb;
  v_line jsonb;
  v_customer jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_final_lines jsonb := '[]'::jsonb;
  v_ord integer;
  v_position integer;
  v_service_id uuid;
  v_line_id uuid;
  v_timing_preference text;
  v_resolved_timing_mode text;
  v_previous_line jsonb;
  v_previous_service_id uuid;
  v_parallel_policy_id uuid;
  v_parallel_policy_mode text;
  v_sequential_anchor timestamptz;
  v_staff_preference text;
  v_staff_id uuid;
  v_explicit_staff_id uuid;
  v_common_staff_id uuid;
  v_resource_id uuid;
  v_addon_ids uuid[];
  v_customer_start timestamptz;
  v_customer_end timestamptz;
  v_occupied_start timestamptz;
  v_occupied_end timestamptz;
  v_expected_end timestamptz;
  v_service_duration integer;
  v_prep_minutes integer;
  v_trailing_buffer integer;
  v_sequence_extra integer;
  v_expected_block_extra integer;
  v_search_minutes integer;
  v_quote jsonb;
  v_platform_enabled boolean;
  v_salon_enabled boolean;
  v_qa_allowlisted boolean := false;
  v_salon_archived timestamptz;
  v_currency text;
  v_tax_lines jsonb;
  v_tax_line jsonb;
  v_tax_rate numeric;
  v_tax_enabled boolean;
  v_tax_line_amount integer;
  v_tax_floor_sum integer;
  v_tax_remainder_count integer;
  v_tax_breakdown jsonb := '[]'::jsonb;
  v_original integer := 0;
  v_promo integer := 0;
  v_email integer := 0;
  v_voucher_discount integer := 0;
  v_pre_voucher integer := 0;
  v_eligible_total integer := 0;
  v_remaining integer := 0;
  v_subtotal integer := 0;
  v_tax integer := 0;
  v_total integer := 0;
  v_service_pre integer;
  v_addon_pre integer;
  v_email_alloc integer;
  v_voucher_alloc integer;
  v_line_pre integer;
  v_line_subtotal integer;
  v_final_service integer;
  v_final_addon integer;
  v_profile_id uuid;
  v_email_claimed_at timestamptz;
  v_voucher public.vouchers%ROWTYPE;
  v_voucher_code text;
  v_is_eligible boolean;
  v_free_applied boolean := false;
  v_voucher_allocations jsonb := '{}'::jsonb;
  v_material jsonb;
  v_fingerprint text;
  v_timing_segments jsonb;
  v_catalog_ready boolean := false;
  v_service_name text;
  v_service_category text;
  v_timezone text;
  v_local_occupied_start timestamp;
  v_local_occupied_end timestamp;
  v_shift_day text;
  v_opening_hours jsonb;
  v_day_config jsonb;
  v_resources_enabled boolean;
  v_schedule_only boolean := false;
  v_exclude_booking_id uuid;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_request IS NULL
     OR pg_catalog.jsonb_typeof(p_request) <> 'object'
     OR (p_request - ARRAY[
       'contract_version', 'salon_id', 'request_id',
       'requested_start_time_utc', 'lines', 'same_staff_for_all',
       'voucher_code', 'customer',
       'apply_email_discount', 'expected_pricing_fingerprint',
       'otp_session_id', 'health_acknowledged',
       'sms_consent', 'notification_language',
       'schedule_only', 'exclude_booking_id'
     ]::text[]) <> '{}'::jsonb THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
  END IF;

  BEGIN
    IF (p_request->>'contract_version')::integer <> 1 THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unsupported_contract');
    END IF;
    v_salon_id := (p_request->>'salon_id')::uuid;
    v_request_id := nullif(p_request->>'request_id', '')::uuid;
    v_requested_start := (p_request->>'requested_start_time_utc')::timestamptz;
    v_same_staff := coalesce((p_request->>'same_staff_for_all')::boolean, false);
    v_apply_email := coalesce((p_request->>'apply_email_discount')::boolean, false);
    v_schedule_only := coalesce((p_request->>'schedule_only')::boolean, false);
    v_exclude_booking_id := nullif(p_request->>'exclude_booking_id', '')::uuid;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format
    OR datetime_field_overflow THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
  END;
  v_customer := p_request->'customer';
  v_voucher_code := nullif(upper(trim(coalesce(p_request->>'voucher_code', ''))), '');
  IF pg_catalog.jsonb_typeof(v_customer) IS DISTINCT FROM 'object'
     OR (v_customer - ARRAY['name', 'phone', 'email']::text[]) <> '{}'::jsonb THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
  END IF;
  v_client_phone := pg_catalog.regexp_replace(coalesce(v_customer->>'phone', ''), '\D', '', 'g');
  v_client_email := nullif(lower(trim(coalesce(v_customer->>'email', ''))), '');
  v_lines_input := p_request->'lines';

  IF v_schedule_only IS DISTINCT FROM (v_exclude_booking_id IS NOT NULL)
     OR (v_schedule_only AND NOT EXISTS (
       SELECT 1 FROM public.bookings existing
       WHERE existing.id=v_exclude_booking_id
         AND existing.salon_id=v_salon_id
         AND existing.schedule_model='segments_v1'
         AND existing.sequence_version=1
         AND existing.deleted_at IS NULL
     )) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
  END IF;

  IF v_salon_id IS NULL OR v_requested_start IS NULL
     OR length(v_client_phone) < 7
     OR length(trim(coalesce(v_customer->>'name', ''))) NOT BETWEEN 1 AND 120
     OR trim(v_customer->>'name') ~ '[<>{}=&;]'
     OR (v_client_email IS NOT NULL AND (
       length(v_client_email) > 254
       OR v_client_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     ))
     OR pg_catalog.jsonb_typeof(v_lines_input) IS DISTINCT FROM 'array'
     OR pg_catalog.jsonb_array_length(v_lines_input) NOT BETWEEN 1 AND 5 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
  END IF;

  SELECT coalesce(pff.enabled, false)
  INTO v_platform_enabled
  FROM public.platform_flags pff
  WHERE pff.key = 'feature_multi_service_booking';
  v_platform_enabled := coalesce(v_platform_enabled, false);

  SELECT
    s.feature_flags->'multi_service_booking_enabled' = 'true'::jsonb,
    s.archived_at,
    coalesce(nullif(trim(s.currency_code), ''), 'USD'),
    s.tax_lines,
    coalesce(nullif(trim(s.timezone), ''), 'America/Los_Angeles'),
    s.opening_hours,
    coalesce(s.resources_enabled, false)
  INTO v_salon_enabled, v_salon_archived, v_currency, v_tax_lines, v_timezone,
    v_opening_hours, v_resources_enabled
  FROM public.salons s
  WHERE s.id = v_salon_id;
  IF NOT FOUND OR v_salon_archived IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_reference');
  END IF;
  -- Preserve the card-safe sequence payment policy introduced after the
  -- original resolver. Quote remains read-only; commit locks policy material.
  IF NOT public.booking_sequence_payment_policy_ready(v_salon_id, p_lock_claims) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'payment_not_supported');
  END IF;
  SELECT public.multi_service_booking_rollout_authorized(v_salon_id)
  INTO v_qa_allowlisted;
  SELECT (
    count(*) FILTER (
      WHERE svc.deleted_at IS NULL AND svc.is_addon IS FALSE
        AND svc.price_cents >= 0 AND svc.duration_minutes > 0
        AND svc.buffer_minutes >= 0 AND svc.prep_minutes BETWEEN 0 AND 180
    ) >= 2
    AND EXISTS (
      SELECT 1 FROM public.staff st
      WHERE st.salon_id = v_salon_id AND st.status = 'active' AND st.deleted_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.services required
      WHERE required.salon_id = v_salon_id
        AND required.deleted_at IS NULL AND required.is_addon IS FALSE
        AND EXISTS (
          SELECT 1 FROM public.staff_services configured
          JOIN public.staff configured_staff ON configured_staff.id = configured.staff_id
          WHERE configured_staff.salon_id = v_salon_id
            AND configured_staff.status = 'active' AND configured_staff.deleted_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.staff_services ss
          JOIN public.staff capable ON capable.id = ss.staff_id
          WHERE ss.service_id = required.id
            AND capable.salon_id = v_salon_id
            AND capable.status = 'active' AND capable.deleted_at IS NULL
        )
    )
    AND (NOT v_resources_enabled OR EXISTS (
      SELECT 1 FROM public.salon_resources r
      WHERE r.salon_id = v_salon_id AND r.status = 'active' AND r.deleted_at IS NULL
    ))
  ) INTO v_catalog_ready
  FROM public.services svc
  WHERE svc.salon_id = v_salon_id;

  IF NOT v_platform_enabled OR NOT coalesce(v_salon_enabled, false)
     OR NOT coalesce(v_qa_allowlisted, false)
     OR NOT coalesce(v_catalog_ready, false) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'feature_disabled',
      'readiness', pg_catalog.jsonb_build_object(
        'contract_version', 1,
        'schedule_model', 'segments_v1',
        'platform_enabled', v_platform_enabled,
        'salon_enabled', coalesce(v_salon_enabled, false),
        'qa_allowlisted', coalesce(v_qa_allowlisted, false),
        'catalog_ready', coalesce(v_catalog_ready, false),
        'ready', false
      )
    );
  END IF;
  IF pg_catalog.jsonb_typeof(v_tax_lines) IS DISTINCT FROM 'array' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'pricing_config_invalid');
  END IF;

  IF p_lock_claims THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'booking-sequence-capacity:' || v_salon_id::text, 0
      )
    );
    PERFORM p.key FROM public.platform_flags p
    WHERE p.key = 'feature_multi_service_booking' FOR UPDATE;
    PERFORM ps.id FROM public.platform_settings ps
    WHERE ps.id = 'platform' FOR UPDATE;
    SELECT coalesce(p.enabled, false) INTO v_platform_enabled
    FROM public.platform_flags p WHERE p.key = 'feature_multi_service_booking';
    SELECT
      s.feature_flags->'multi_service_booking_enabled' = 'true'::jsonb,
      s.archived_at, s.tax_lines
    INTO v_salon_enabled, v_salon_archived, v_tax_lines
    FROM public.salons s WHERE s.id = v_salon_id FOR UPDATE;
    IF NOT coalesce(v_platform_enabled, false)
       OR NOT coalesce(v_salon_enabled, false)
       OR v_salon_archived IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'feature_disabled');
    END IF;
    IF NOT public.multi_service_booking_rollout_authorized(v_salon_id) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'feature_disabled');
    END IF;
    PERFORM svc.id
    FROM public.services svc
    WHERE svc.id IN (
      SELECT (l.value->>'service_id')::uuid
      FROM pg_catalog.jsonb_array_elements(v_lines_input) l(value)
      UNION
      SELECT a.value::uuid
      FROM pg_catalog.jsonb_array_elements(v_lines_input) l(value)
      CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(
        coalesce(l.value->'addon_service_ids', '[]'::jsonb)
      ) a(value)
    )
    ORDER BY svc.id FOR UPDATE;
    PERFORM p.id FROM public.promotions p
    WHERE p.salon_id = v_salon_id AND p.active IS TRUE
    ORDER BY p.id FOR UPDATE;
    PERFORM ps.id FROM public.promotion_services ps
    JOIN public.promotions p ON p.id = ps.promotion_id
    WHERE p.salon_id = v_salon_id AND p.active IS TRUE
    ORDER BY ps.id FOR UPDATE OF ps;
  END IF;

  IF v_voucher_code IS NOT NULL THEN
    SELECT v.id INTO v_voucher_id
    FROM public.vouchers v
    WHERE v.salon_id = v_salon_id AND upper(v.code) = v_voucher_code;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'voucher_invalid');
    END IF;
  END IF;

  -- same_staff_for_all is an intersection, not a first-line guess. An explicit
  -- UUID on any line fixes the common candidate; conflicting explicit UUIDs
  -- fail before schedule/pricing resolution.
  IF v_same_staff THEN
    BEGIN
      SELECT count(DISTINCT e.value->>'staff_preference'),
             min(e.value->>'staff_preference')
      INTO v_ord, v_staff_preference
      FROM pg_catalog.jsonb_array_elements(v_lines_input) e(value)
      WHERE e.value->>'staff_preference' IS DISTINCT FROM 'any';
      IF v_ord > 1 THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'same_staff_mismatch');
      END IF;
      v_common_staff_id := nullif(v_staff_preference, '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_line');
    END;
  END IF;

  v_customer_start := v_requested_start;
  FOR v_line_input, v_ord IN
    SELECT e.value, e.ordinality::integer
    FROM pg_catalog.jsonb_array_elements(v_lines_input)
      WITH ORDINALITY AS e(value, ordinality)
    ORDER BY e.ordinality
  LOOP
    v_position := v_ord - 1;
    IF pg_catalog.jsonb_typeof(v_line_input) <> 'object'
       OR (v_line_input - ARRAY[
         'line_id', 'position', 'service_id', 'staff_preference',
         'preferred_resource_id', 'addon_service_ids', 'timing_preference'
       ]::text[]) <> '{}'::jsonb THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_line');
    END IF;
    BEGIN
      v_line_id := (v_line_input->>'line_id')::uuid;
      IF (v_line_input->>'position')::integer <> v_position THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_line_order');
      END IF;
      v_service_id := (v_line_input->>'service_id')::uuid;
      v_timing_preference := coalesce(nullif(v_line_input->>'timing_preference', ''), 'sequential');
      IF v_timing_preference NOT IN ('sequential', 'parallel')
         OR (v_position = 0 AND v_timing_preference <> 'sequential')
         OR (v_position > 1 AND v_timing_preference = 'parallel') THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_timing_preference');
      END IF;
      v_staff_preference := v_line_input->>'staff_preference';
      v_explicit_staff_id := CASE WHEN v_staff_preference = 'any' THEN NULL
        ELSE v_staff_preference::uuid END;
      v_resource_id := nullif(v_line_input->>'preferred_resource_id', '')::uuid;
      IF v_line_input->'addon_service_ids' IS NULL THEN
        v_addon_ids := ARRAY[]::uuid[];
      ELSIF pg_catalog.jsonb_typeof(v_line_input->'addon_service_ids') = 'array' THEN
        SELECT coalesce(array_agg(a.value::uuid ORDER BY a.ordinality), ARRAY[]::uuid[])
        INTO v_addon_ids
        FROM pg_catalog.jsonb_array_elements_text(v_line_input->'addon_service_ids')
          WITH ORDINALITY a(value, ordinality);
      ELSE
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_addon');
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_line');
    END;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(v_lines) prior(value)
      WHERE prior.value->>'line_id' = v_line_id::text
    ) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'duplicate_line_id');
    END IF;
    IF pg_catalog.cardinality(v_addon_ids) > 8
       OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_addon_ids) x(id) WHERE x.id IS NULL)
       OR (SELECT count(DISTINCT x.id) FROM pg_catalog.unnest(v_addon_ids) x(id))
          <> pg_catalog.cardinality(v_addon_ids) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_addon');
    END IF;

    SELECT s.duration_minutes, s.prep_minutes, s.name, s.category
    INTO v_service_duration, v_prep_minutes, v_service_name, v_service_category
    FROM public.services s
    WHERE s.id = v_service_id
      AND s.salon_id = v_salon_id
      AND s.deleted_at IS NULL
      AND s.is_addon IS FALSE
      AND s.duration_minutes BETWEEN 1 AND 1440
      AND s.price_cents >= 0;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_reference');
    END IF;

    v_resolved_timing_mode := 'sequential';
    v_parallel_policy_id := NULL;
    v_parallel_policy_mode := NULL;
    IF v_position = 0 THEN
      v_customer_start := v_requested_start;
    ELSE
      SELECT max((prior.value->>'customer_end_utc')::timestamptz)
      INTO v_sequential_anchor
      FROM pg_catalog.jsonb_array_elements(v_lines) prior(value);
      v_customer_start := v_sequential_anchor;
      IF v_timing_preference = 'parallel' THEN
        IF v_same_staff THEN
          RETURN pg_catalog.jsonb_build_object(
            'success', false, 'code', 'parallel_requires_distinct_staff'
          );
        END IF;
        v_previous_line := v_lines->(v_position - 1);
        v_previous_service_id := (v_previous_line->>'service_id')::uuid;
        SELECT p.id, p.resource_mode
        INTO v_parallel_policy_id, v_parallel_policy_mode
        FROM public.service_parallel_policies p
        WHERE p.salon_id = v_salon_id
          AND p.service_a_id = CASE
            WHEN v_previous_service_id::text < v_service_id::text
            THEN v_previous_service_id ELSE v_service_id END
          AND p.service_b_id = CASE
            WHEN v_previous_service_id::text < v_service_id::text
            THEN v_service_id ELSE v_previous_service_id END
          AND p.active IS TRUE;
        IF v_parallel_policy_id IS NULL THEN
          RETURN pg_catalog.jsonb_build_object(
            'success', false, 'code', 'parallel_pair_not_allowed'
          );
        END IF;
        IF NOT v_resources_enabled THEN
          RETURN pg_catalog.jsonb_build_object(
            'success', false, 'code', 'parallel_resource_unproven'
          );
        END IF;
        v_resolved_timing_mode := 'parallel';
        v_customer_start := (v_previous_line->>'customer_start_utc')::timestamptz;
      END IF;
    END IF;

    SELECT s.buffer_minutes + coalesce(sum(
      CASE WHEN a.addon_timing = 'concurrent' THEN 0
           ELSE a.duration_minutes + a.buffer_minutes END
    ), 0)::integer
    INTO v_sequence_extra
    FROM public.services s
    LEFT JOIN pg_catalog.unnest(v_addon_ids) req(id) ON true
    LEFT JOIN public.services a ON a.id = req.id
      AND a.salon_id = v_salon_id AND a.deleted_at IS NULL AND a.is_addon IS TRUE
    WHERE s.id = v_service_id
    GROUP BY s.buffer_minutes;
    v_expected_end := v_customer_start
      + pg_catalog.make_interval(mins => v_service_duration + v_sequence_extra);
    v_expected_block_extra := v_sequence_extra;
    v_occupied_start := v_customer_start
      - pg_catalog.make_interval(mins => v_prep_minutes);

    IF v_resolved_timing_mode = 'parallel'
       AND v_parallel_policy_mode IN ('shared', 'either') THEN
      SELECT r.id INTO v_resource_id
      FROM public.salon_resources r
      WHERE r.salon_id = v_salon_id
        AND r.status = 'active' AND r.deleted_at IS NULL
        AND r.same_guest_parallel_capacity >= 2
        AND (
          nullif(v_line_input->>'preferred_resource_id', '') IS NULL
          OR r.id = (v_line_input->>'preferred_resource_id')::uuid
        )
        AND (
          nullif(v_lines_input->(v_position - 1)->>'preferred_resource_id', '') IS NULL
          OR r.id = (v_lines_input->(v_position - 1)->>'preferred_resource_id')::uuid
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.bookings b
          WHERE b.salon_id = v_salon_id AND b.schedule_model = 'single'
            AND b.resource_id = r.id
            AND b.status NOT IN ('cancelled', 'no_show', 'completed')
            AND pg_catalog.tstzrange(b.start_time_utc, b.end_time_utc, '[)')
              && pg_catalog.tstzrange(
                least((v_previous_line->>'occupied_start_utc')::timestamptz, v_occupied_start),
                greatest((v_previous_line->>'occupied_end_utc')::timestamptz, v_expected_end), '[)'
              )
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.booking_service_segments seg
          WHERE seg.salon_id = v_salon_id AND seg.resource_id = r.id
            AND seg.booking_id IS DISTINCT FROM v_exclude_booking_id
            AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
            AND pg_catalog.tstzrange(seg.occupied_start_utc, seg.occupied_end_utc, '[)')
              && pg_catalog.tstzrange(
                least((v_previous_line->>'occupied_start_utc')::timestamptz, v_occupied_start),
                greatest((v_previous_line->>'occupied_end_utc')::timestamptz, v_expected_end), '[)'
              )
        )
      ORDER BY public.salon_resource_booked_minutes_for_day(
        v_salon_id, r.id,
        (v_occupied_start AT TIME ZONE v_timezone)::date,
        v_timezone, '[]'::jsonb, v_exclude_booking_id
      ) ASC, r.display_order ASC, r.id
      LIMIT 1;
      IF v_resource_id IS NULL AND v_parallel_policy_mode = 'shared' THEN
        RETURN pg_catalog.jsonb_build_object(
          'success', false, 'code', 'no_shared_parallel_resource'
        );
      END IF;
      IF v_resource_id IS NOT NULL THEN
        v_lines := pg_catalog.jsonb_set(
          pg_catalog.jsonb_set(
            v_lines,
            ARRAY[(v_position - 1)::text, 'resource_id'],
            pg_catalog.to_jsonb(v_resource_id), false
          ),
          ARRAY[(v_position - 1)::text, 'resolved_resource_id'],
          pg_catalog.to_jsonb(v_resource_id), false
        );
        v_previous_line := v_lines->(v_position - 1);
      ELSE
        -- `either` falls back to the normal distinct-resource search while
        -- preserving an explicit preference supplied for the current line.
        v_resource_id := nullif(v_line_input->>'preferred_resource_id', '')::uuid;
        IF v_resource_id IS NOT NULL
           AND v_resource_id = nullif(v_previous_line->>'resource_id', '')::uuid THEN
          RETURN pg_catalog.jsonb_build_object(
            'success', false, 'code', 'no_shared_parallel_resource'
          );
        END IF;
      END IF;
    END IF;

    IF v_resource_id IS NULL AND v_resources_enabled THEN
      v_search_minutes := 0;
      <<resource_search>>
      LOOP
      v_occupied_start := v_customer_start
        - pg_catalog.make_interval(mins => v_prep_minutes);
      v_expected_end := v_customer_start
        + pg_catalog.make_interval(mins => v_service_duration + v_expected_block_extra);
      SELECT r.id INTO v_resource_id
      FROM public.salon_resources r
      WHERE r.salon_id = v_salon_id AND r.status = 'active' AND r.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.bookings b
          WHERE b.salon_id = v_salon_id AND b.schedule_model = 'single'
            AND b.resource_id = r.id
            AND b.status NOT IN ('cancelled', 'no_show', 'completed')
            AND pg_catalog.tstzrange(b.start_time_utc, b.end_time_utc, '[)')
              && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.booking_service_segments seg
          WHERE seg.salon_id = v_salon_id AND seg.resource_id = r.id
            AND seg.booking_id IS DISTINCT FROM v_exclude_booking_id
            AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
            AND pg_catalog.tstzrange(seg.occupied_start_utc, seg.occupied_end_utc, '[)')
              && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
        )
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.jsonb_array_elements(v_lines) prior(value)
          WHERE prior.value->>'resource_id' = r.id::text
            AND pg_catalog.tstzrange(
              (prior.value->>'occupied_start_utc')::timestamptz,
              (prior.value->>'occupied_end_utc')::timestamptz, '[)'
            ) && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
        )
      ORDER BY public.salon_resource_booked_minutes_for_day(
        v_salon_id, r.id,
        (v_occupied_start AT TIME ZONE v_timezone)::date,
        v_timezone, v_lines, v_exclude_booking_id
      ) ASC, r.display_order ASC, r.id LIMIT 1;
      IF v_resource_id IS NULL THEN
        IF v_position > 0 AND v_resolved_timing_mode <> 'parallel' AND v_search_minutes < 720 THEN
          v_customer_start := v_customer_start + interval '1 minute';
          v_search_minutes := v_search_minutes + 1;
          CONTINUE resource_search;
        END IF;
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'no_resource_available');
      END IF;
      EXIT resource_search;
      END LOOP resource_search;
    END IF;

    IF v_resource_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.salon_resources r
      WHERE r.id = v_resource_id AND r.salon_id = v_salon_id
        AND r.status = 'active' AND r.deleted_at IS NULL
    ) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_resource');
    END IF;

    IF v_same_staff AND v_common_staff_id IS NOT NULL THEN
      v_staff_id := v_common_staff_id;
      IF v_explicit_staff_id IS NOT NULL AND v_explicit_staff_id <> v_staff_id THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'same_staff_mismatch');
      END IF;
    ELSE
      v_staff_id := v_explicit_staff_id;
    END IF;

    -- Determine a staff candidate before pricing; the authoritative single-line
    -- resolver repeats active/capability validation. Existing and earlier
    -- requested capacity is filtered here; exclusion constraints close races.
    -- For a later line, search candidate minutes in ascending order and choose
    -- the lowest stable staff UUID at the first minute with capacity. This is
    -- the required earliest-completion-then-UUID rule for `any`.
    IF v_staff_id IS NULL THEN
      v_search_minutes := 0;
      <<any_staff_search>>
      LOOP
      SELECT st.id INTO v_staff_id
      FROM public.staff st
      WHERE st.salon_id = v_salon_id
        AND st.status = 'active'
        AND st.deleted_at IS NULL
        AND (
          NOT EXISTS (
            SELECT 1 FROM public.staff_services ss0
            JOIN public.staff st0 ON st0.id = ss0.staff_id
            WHERE st0.salon_id = v_salon_id
              AND st0.status = 'active' AND st0.deleted_at IS NULL
          )
          OR (
            SELECT count(DISTINCT ss.service_id)
            FROM public.staff_services ss
            WHERE ss.staff_id = st.id
              AND ss.service_id = ANY(ARRAY[v_service_id]::uuid[] || v_addon_ids)
          ) = pg_catalog.cardinality(ARRAY[v_service_id]::uuid[] || v_addon_ids)
        )
        AND (
          NOT v_same_staff OR NOT EXISTS (
            SELECT requested.service_id
            FROM (
              SELECT (l.value->>'service_id')::uuid AS service_id
              FROM pg_catalog.jsonb_array_elements(v_lines_input) l(value)
              UNION
              SELECT a.value::uuid
              FROM pg_catalog.jsonb_array_elements(v_lines_input) l(value)
              CROSS JOIN LATERAL pg_catalog.jsonb_array_elements_text(
                coalesce(l.value->'addon_service_ids', '[]'::jsonb)
              ) a(value)
            ) requested
            WHERE EXISTS (
              SELECT 1 FROM public.staff_services any_map
              JOIN public.staff mapped ON mapped.id = any_map.staff_id
              WHERE mapped.salon_id = v_salon_id
                AND mapped.status = 'active' AND mapped.deleted_at IS NULL
            ) AND NOT EXISTS (
              SELECT 1 FROM public.staff_services ss
              WHERE ss.staff_id = st.id AND ss.service_id = requested.service_id
            )
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.bookings b
          WHERE b.salon_id = v_salon_id AND b.schedule_model = 'single'
            AND b.staff_id = st.id
            AND b.status NOT IN ('cancelled', 'no_show', 'completed')
            AND pg_catalog.tstzrange(b.start_time_utc, b.end_time_utc, '[)')
              && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.booking_service_segments seg
          WHERE seg.salon_id = v_salon_id AND seg.staff_id = st.id
            AND seg.booking_id IS DISTINCT FROM v_exclude_booking_id
            AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
            AND pg_catalog.tstzrange(seg.occupied_start_utc, seg.occupied_end_utc, '[)')
              && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.staff_unavailability su
          WHERE su.salon_id = v_salon_id AND su.staff_id = st.id
            AND su.date = (v_occupied_start AT TIME ZONE v_timezone)::date
        )
        AND (
          NOT EXISTS (SELECT 1 FROM public.staff_shifts any_shift
            WHERE any_shift.staff_id = st.id)
          OR EXISTS (
            SELECT 1 FROM public.staff_shifts sh
            WHERE sh.staff_id = st.id AND sh.salon_id = v_salon_id
              AND sh.is_active IS TRUE
              AND sh.day_of_week = (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[
                extract(dow FROM (v_occupied_start AT TIME ZONE v_timezone))::integer + 1
              ]
              AND (v_occupied_start AT TIME ZONE v_timezone)::date
                = (v_expected_end AT TIME ZONE v_timezone)::date
              AND (v_occupied_start AT TIME ZONE v_timezone)::time >= sh.start_time::time
              AND (v_expected_end AT TIME ZONE v_timezone)::time <= sh.end_time::time
              AND NOT (sh.break_start_time IS NOT NULL AND sh.break_end_time IS NOT NULL
                AND (v_occupied_start AT TIME ZONE v_timezone)::time < sh.break_end_time
                AND (v_expected_end AT TIME ZONE v_timezone)::time > sh.break_start_time)
          )
        )
      ORDER BY st.id
      LIMIT 1;
      IF v_staff_id IS NOT NULL THEN
        EXIT any_staff_search;
      END IF;
      IF v_position > 0 AND v_resolved_timing_mode <> 'parallel' AND v_search_minutes < 720 THEN
        v_customer_start := v_customer_start + interval '1 minute';
        v_search_minutes := v_search_minutes + 1;
        v_occupied_start := v_customer_start
          - pg_catalog.make_interval(mins => v_prep_minutes);
        v_expected_end := v_customer_start
          + pg_catalog.make_interval(mins => v_service_duration + v_expected_block_extra);
        CONTINUE any_staff_search;
      END IF;
      EXIT any_staff_search;
      END LOOP any_staff_search;
    END IF;
    IF v_staff_id IS NULL THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'no_staff_available');
    END IF;
    IF v_same_staff AND v_common_staff_id IS NULL THEN
      v_common_staff_id := v_staff_id;
    END IF;
    IF p_lock_claims THEN
      PERFORM st.id FROM public.staff st
      WHERE st.id = v_staff_id AND st.salon_id = v_salon_id
        AND st.status = 'active' AND st.deleted_at IS NULL
      FOR UPDATE;
      IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'staff_state_changed');
      END IF;
    END IF;

    -- Customer work remains ordered. If this line reuses capacity, move its
    -- customer start just enough that its prep begins after the prior occupied
    -- interval. Different capacity may prepare during prior customer work.
    SELECT greatest(
      v_customer_start,
      coalesce(max((prior.value->>'occupied_end_utc')::timestamptz)
        + pg_catalog.make_interval(mins => v_prep_minutes), v_customer_start)
    )
    INTO v_customer_start
    FROM pg_catalog.jsonb_array_elements(v_lines) prior(value)
    WHERE prior.value->>'staff_id' = v_staff_id::text
       OR (
         v_resource_id IS NOT NULL
         AND prior.value->>'resource_id' = v_resource_id::text
         AND NOT (
           v_resolved_timing_mode = 'parallel'
           AND v_parallel_policy_mode IN ('shared', 'either')
         )
       );

    -- Ask the existing authoritative line resolver for catalog, promotions,
    -- add-ons, hours, active staff, and capability truth. End is derived from
    -- immutable catalog data, never caller money/duration.
    v_search_minutes := 0;
    <<sequence_slot_search>>
    LOOP
    v_expected_end := v_customer_start
      + pg_catalog.make_interval(mins => v_service_duration + v_expected_block_extra);
    v_occupied_start := v_customer_start
      - pg_catalog.make_interval(mins => v_prep_minutes);

    -- Staff search may have moved a later line. Re-resolve an `any` resource
    -- at that exact candidate minute so an initially selected resource cannot
    -- force a later finish while another active resource is already free.
    IF v_resources_enabled
       AND v_resolved_timing_mode <> 'parallel'
       AND nullif(v_line_input->>'preferred_resource_id', '') IS NULL THEN
      v_resource_id := NULL;
      IF p_lock_claims THEN
        SELECT r.id INTO v_resource_id
        FROM public.salon_resources r
        WHERE r.salon_id = v_salon_id
          AND r.status = 'active' AND r.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.bookings b
            WHERE b.salon_id = v_salon_id AND b.schedule_model = 'single'
              AND b.resource_id = r.id
              AND b.status NOT IN ('cancelled', 'no_show', 'completed')
              AND pg_catalog.tstzrange(b.start_time_utc, b.end_time_utc, '[)')
                && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.booking_service_segments seg
            WHERE seg.salon_id = v_salon_id AND seg.resource_id = r.id
              AND seg.booking_id IS DISTINCT FROM v_exclude_booking_id
              AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
              AND pg_catalog.tstzrange(seg.occupied_start_utc, seg.occupied_end_utc, '[)')
                && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
          )
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(v_lines) prior(value)
            WHERE prior.value->>'resource_id' = r.id::text
              AND pg_catalog.tstzrange(
                (prior.value->>'occupied_start_utc')::timestamptz,
                (prior.value->>'occupied_end_utc')::timestamptz, '[)'
              ) && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
          )
        ORDER BY public.salon_resource_booked_minutes_for_day(
          v_salon_id, r.id,
          (v_occupied_start AT TIME ZONE v_timezone)::date,
          v_timezone, v_lines, v_exclude_booking_id
        ) ASC, r.display_order ASC, r.id LIMIT 1 FOR UPDATE;
      ELSE
        SELECT r.id INTO v_resource_id
        FROM public.salon_resources r
        WHERE r.salon_id = v_salon_id
          AND r.status = 'active' AND r.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.bookings b
            WHERE b.salon_id = v_salon_id AND b.schedule_model = 'single'
              AND b.resource_id = r.id
              AND b.status NOT IN ('cancelled', 'no_show', 'completed')
              AND pg_catalog.tstzrange(b.start_time_utc, b.end_time_utc, '[)')
                && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.booking_service_segments seg
            WHERE seg.salon_id = v_salon_id AND seg.resource_id = r.id
              AND seg.booking_id IS DISTINCT FROM v_exclude_booking_id
              AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
              AND pg_catalog.tstzrange(seg.occupied_start_utc, seg.occupied_end_utc, '[)')
                && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
          )
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(v_lines) prior(value)
            WHERE prior.value->>'resource_id' = r.id::text
              AND pg_catalog.tstzrange(
                (prior.value->>'occupied_start_utc')::timestamptz,
                (prior.value->>'occupied_end_utc')::timestamptz, '[)'
              ) && pg_catalog.tstzrange(v_occupied_start, v_expected_end, '[)')
          )
        ORDER BY public.salon_resource_booked_minutes_for_day(
          v_salon_id, r.id,
          (v_occupied_start AT TIME ZONE v_timezone)::date,
          v_timezone, v_lines, v_exclude_booking_id
        ) ASC, r.display_order ASC, r.id LIMIT 1;
      END IF;
      IF v_resource_id IS NULL THEN
        IF v_position > 0 AND v_resolved_timing_mode <> 'parallel' AND v_search_minutes < 720 THEN
          v_customer_start := v_customer_start + interval '1 minute';
          v_search_minutes := v_search_minutes + 1;
          CONTINUE sequence_slot_search;
        END IF;
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'no_resource_available');
      END IF;
    ELSIF v_resource_id IS NOT NULL AND p_lock_claims THEN
      PERFORM r.id FROM public.salon_resources r
      WHERE r.id = v_resource_id AND r.salon_id = v_salon_id
        AND r.status = 'active' AND r.deleted_at IS NULL
      FOR UPDATE;
      IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'resource_state_changed');
      END IF;
    END IF;

    v_quote := public.resolve_public_booking_pricing(
      v_salon_id, v_service_id, v_staff_id,
      v_customer_start, v_expected_end, v_addon_ids,
      NULL, NULL, v_client_phone, NULL, false, false
    );
    IF coalesce(v_quote->>'success', 'false') <> 'true' THEN
      RETURN v_quote;
    END IF;
    v_trailing_buffer := (v_quote->>'trailing_buffer_minutes')::integer;
    v_occupied_end := v_expected_end;
    v_customer_end := v_expected_end
      - pg_catalog.make_interval(mins => v_trailing_buffer);
    v_sequence_extra := extract(epoch FROM (v_customer_end - v_customer_start))::integer / 60
      - v_service_duration;
    IF v_sequence_extra < 0 THEN
      RAISE EXCEPTION 'sequence duration invariant failed';
    END IF;

    v_local_occupied_start := v_occupied_start AT TIME ZONE v_timezone;
    v_local_occupied_end := v_occupied_end AT TIME ZONE v_timezone;
    v_shift_day := (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[
      extract(dow FROM v_local_occupied_start)::integer + 1
    ];
    v_day_config := v_opening_hours->v_shift_day;
    BEGIN
      IF pg_catalog.jsonb_typeof(v_day_config) IS DISTINCT FROM 'object'
         OR coalesce((v_day_config->>'closed')::boolean, false)
         OR v_local_occupied_start::date <> v_local_occupied_end::date
         OR v_local_occupied_start::time < (v_day_config->>'open')::time
         OR (
           CASE WHEN v_position = pg_catalog.jsonb_array_length(v_lines_input) - 1
             THEN (v_customer_end AT TIME ZONE v_timezone)::time
             ELSE v_local_occupied_end::time
           END
         ) > (v_day_config->>'close')::time THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'outside_hours');
      END IF;
    EXCEPTION WHEN invalid_datetime_format OR invalid_text_representation THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'pricing_config_invalid');
    END;
    IF EXISTS (
      SELECT 1 FROM public.staff_unavailability su
      WHERE su.staff_id = v_staff_id AND su.salon_id = v_salon_id
        AND su.date = v_local_occupied_start::date
    ) OR (
      EXISTS (SELECT 1 FROM public.staff_shifts any_shift WHERE any_shift.staff_id = v_staff_id)
      AND NOT EXISTS (
        SELECT 1 FROM public.staff_shifts sh
        WHERE sh.staff_id = v_staff_id AND sh.salon_id = v_salon_id
          AND sh.is_active IS TRUE AND sh.day_of_week = v_shift_day
          AND v_local_occupied_start::date = v_local_occupied_end::date
          AND v_local_occupied_start::time >= sh.start_time::time
          AND v_local_occupied_end::time <= sh.end_time::time
          AND NOT (
            sh.break_start_time IS NOT NULL AND sh.break_end_time IS NOT NULL
            AND v_local_occupied_start::time < sh.break_end_time
            AND v_local_occupied_end::time > sh.break_start_time
          )
      )
    ) THEN
      IF v_position > 0 AND v_resolved_timing_mode <> 'parallel' AND v_search_minutes < 720 THEN
        v_customer_start := v_customer_start + interval '1 minute';
        v_search_minutes := v_search_minutes + 1;
        CONTINUE sequence_slot_search;
      END IF;
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'staff_unavailable');
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.salon_id = v_salon_id AND b.schedule_model = 'single'
        AND b.status NOT IN ('cancelled', 'no_show', 'completed')
        AND (b.staff_id = v_staff_id OR (v_resource_id IS NOT NULL AND b.resource_id = v_resource_id))
        AND pg_catalog.tstzrange(b.start_time_utc, b.end_time_utc, '[)')
          && pg_catalog.tstzrange(v_occupied_start, v_occupied_end, '[)')
    ) OR EXISTS (
      SELECT 1 FROM public.booking_service_segments seg
      WHERE seg.salon_id = v_salon_id
        AND seg.booking_id IS DISTINCT FROM v_exclude_booking_id
        AND seg.reservation_status NOT IN ('cancelled', 'no_show', 'completed')
        AND (seg.staff_id = v_staff_id OR (v_resource_id IS NOT NULL AND seg.resource_id = v_resource_id))
        AND pg_catalog.tstzrange(seg.occupied_start_utc, seg.occupied_end_utc, '[)')
          && pg_catalog.tstzrange(v_occupied_start, v_occupied_end, '[)')
    ) OR EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_array_elements(v_lines) prior(value)
      WHERE (prior.value->>'staff_id' = v_staff_id::text
          OR (
            v_resource_id IS NOT NULL
            AND prior.value->>'resource_id' = v_resource_id::text
            AND NOT (
              v_resolved_timing_mode = 'parallel'
              AND v_parallel_policy_mode IN ('shared', 'either')
            )
          ))
        AND pg_catalog.tstzrange(
          (prior.value->>'occupied_start_utc')::timestamptz,
          (prior.value->>'occupied_end_utc')::timestamptz, '[)'
        ) && pg_catalog.tstzrange(v_occupied_start, v_occupied_end, '[)')
    ) THEN
      IF v_position > 0 AND v_resolved_timing_mode <> 'parallel' AND v_search_minutes < 720 THEN
        v_customer_start := v_customer_start + interval '1 minute';
        v_search_minutes := v_search_minutes + 1;
        CONTINUE sequence_slot_search;
      END IF;
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'slot_conflict');
    END IF;
    EXIT sequence_slot_search;
    END LOOP sequence_slot_search;

    v_lines := v_lines || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'position', v_position,
        'line_id', v_line_id,
        'requested_timing_preference', v_timing_preference,
        'resolved_timing_mode', v_resolved_timing_mode,
        'parallel_policy_id', v_parallel_policy_id,
        'service_id', v_service_id,
        'service_name', v_service_name,
        'staff_name', (SELECT st.name FROM public.staff st WHERE st.id = v_staff_id),
        'staff_id', v_staff_id,
        'resolved_staff_id', v_staff_id,
        'resource_id', v_resource_id,
        'resolved_resource_id', v_resource_id,
        'customer_start_utc', v_customer_start,
        'customer_end_utc', v_customer_end,
        'service_start_utc', v_customer_start,
        'service_end_utc', v_customer_end,
        'occupied_start_utc', v_occupied_start,
        'occupied_end_utc', v_occupied_end,
        'prep_minutes', v_prep_minutes,
        'duration_minutes', v_service_duration + v_sequence_extra,
        'service_duration_minutes', v_service_duration,
        'sequential_addon_minutes', v_sequence_extra,
        'trailing_buffer_minutes', v_trailing_buffer,
        'buffer_minutes', v_trailing_buffer,
        'addon_service_ids', v_quote->'addon_service_ids',
        'addon_lines', v_quote->'addon_lines',
        'first_addon_id', v_quote->'first_addon_id',
        'promo_id', v_quote->'promo_id',
        'promo_name', v_quote->'promo_name',
        'original_service_price_cents', (v_quote->>'original_price_cents')::integer,
        'service_pre_voucher_cents', (v_quote->>'service_pre_voucher_cents')::integer,
        'addon_pre_voucher_cents', (v_quote->>'addon_pre_voucher_cents')::integer,
        'promo_discount_cents', coalesce(
          (v_quote->>'promo_discount_cents')::integer, 0
        ),
        'service_category', v_service_category
      )
    );
    v_customer_start := v_customer_end;
  END LOOP;

  IF p_lock_claims THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('public-booking-client:' || v_client_phone, 0)
    );
    PERFORM cp.id FROM public.client_profiles cp
    WHERE cp.phone = v_client_phone FOR UPDATE;
  END IF;
  SELECT cp.id, cp.email_discount_claimed_at
  INTO v_profile_id, v_email_claimed_at
  FROM public.client_profiles cp WHERE cp.phone = v_client_phone;

  IF v_apply_email AND v_client_email IS NOT NULL
     AND (v_profile_id IS NULL OR v_email_claimed_at IS NULL) THEN
    v_email := least(200, (v_lines->0->>'service_pre_voucher_cents')::integer);
  END IF;

  FOR v_line IN
    SELECT value FROM pg_catalog.jsonb_array_elements(v_lines)
    ORDER BY (value->>'position')::integer
  LOOP
    v_email_alloc := CASE WHEN (v_line->>'position')::integer = 0 THEN v_email ELSE 0 END;
    v_line_pre := greatest(0, (v_line->>'service_pre_voucher_cents')::integer - v_email_alloc)
      + (v_line->>'addon_pre_voucher_cents')::integer;
    v_original := v_original + (v_line->>'original_service_price_cents')::integer;
    v_promo := v_promo + (v_line->>'promo_discount_cents')::integer;
    v_pre_voucher := v_pre_voucher + v_line_pre;
  END LOOP;

  IF v_voucher_id IS NOT NULL THEN
    IF p_lock_claims THEN
      SELECT v.* INTO v_voucher FROM public.vouchers v
      WHERE v.id = v_voucher_id FOR UPDATE;
    ELSE
      SELECT v.* INTO v_voucher FROM public.vouchers v WHERE v.id = v_voucher_id;
    END IF;
    IF NOT FOUND OR v_voucher.salon_id <> v_salon_id
       OR v_voucher.revoked_at IS NOT NULL
       OR transaction_timestamp() < v_voucher.valid_from
       OR transaction_timestamp() > v_voucher.expires_at
       OR v_voucher.used_count >= v_voucher.max_uses
       OR (v_voucher.client_phone IS NOT NULL AND
           pg_catalog.regexp_replace(v_voucher.client_phone, '\D', '', 'g') <> v_client_phone)
       OR (v_voucher.client_profile_id IS NOT NULL AND
           v_voucher.client_profile_id IS DISTINCT FROM v_profile_id) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'voucher_invalid');
    END IF;

    FOR v_line IN SELECT value FROM pg_catalog.jsonb_array_elements(v_lines)
    LOOP
      v_is_eligible := (
        coalesce(pg_catalog.cardinality(v_voucher.applicable_service_ids), 0) = 0
        OR (v_line->>'service_id')::uuid = ANY(v_voucher.applicable_service_ids)
      ) AND (
        v_voucher.applicable_service_category IS NULL
        OR v_line->>'service_category' = v_voucher.applicable_service_category
      );
      IF v_is_eligible THEN
        v_eligible_total := v_eligible_total
          + greatest(0, (v_line->>'service_pre_voucher_cents')::integer
              - CASE WHEN (v_line->>'position')::integer = 0 THEN v_email ELSE 0 END)
          + (v_line->>'addon_pre_voucher_cents')::integer;
      END IF;
    END LOOP;
    IF v_pre_voucher < coalesce(v_voucher.min_spend_cents, 0)
       OR v_eligible_total < 1 THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'voucher_invalid');
    END IF;
    IF v_voucher.free_service_id IS NOT NULL THEN
      SELECT greatest(0, (line.value->>'service_pre_voucher_cents')::integer
        - CASE WHEN (line.value->>'position')::integer = 0 THEN v_email ELSE 0 END)
      INTO v_voucher_discount
      FROM pg_catalog.jsonb_array_elements(v_lines) line(value)
      WHERE (line.value->>'service_id')::uuid = v_voucher.free_service_id
        AND (coalesce(pg_catalog.cardinality(v_voucher.applicable_service_ids), 0) = 0
          OR (line.value->>'service_id')::uuid = ANY(v_voucher.applicable_service_ids))
        AND (v_voucher.applicable_service_category IS NULL
          OR line.value->>'service_category' = v_voucher.applicable_service_category)
      ORDER BY (line.value->>'position')::integer
      LIMIT 1;
      IF NOT FOUND OR v_voucher_discount < 1 THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'voucher_invalid');
      END IF;
    ELSIF v_voucher.percent_off IS NOT NULL AND v_voucher.amount_off_cents IS NULL THEN
      v_voucher_discount := floor(v_eligible_total::numeric * v_voucher.percent_off / 100)::integer;
    ELSIF v_voucher.amount_off_cents IS NOT NULL AND v_voucher.percent_off IS NULL THEN
      v_voucher_discount := least(v_eligible_total, v_voucher.amount_off_cents);
    ELSE
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'voucher_invalid');
    END IF;
  END IF;

  IF v_voucher_id IS NOT NULL
     AND v_voucher.free_service_id IS NULL
     AND v_voucher_discount > 0 THEN
    WITH eligible AS (
      SELECT
        (l.value->>'position')::integer AS position,
        l.value->>'line_id' AS line_id,
        greatest(0, (l.value->>'service_pre_voucher_cents')::integer
          - CASE WHEN (l.value->>'position')::integer = 0 THEN v_email ELSE 0 END)
          + (l.value->>'addon_pre_voucher_cents')::integer AS eligible_cents
      FROM pg_catalog.jsonb_array_elements(v_lines) l(value)
      WHERE (
        coalesce(pg_catalog.cardinality(v_voucher.applicable_service_ids), 0) = 0
        OR (l.value->>'service_id')::uuid = ANY(v_voucher.applicable_service_ids)
      ) AND (
        v_voucher.applicable_service_category IS NULL
        OR l.value->>'service_category' = v_voucher.applicable_service_category
      )
    ), shares AS (
      SELECT *,
        floor(v_voucher_discount::numeric * eligible_cents / v_eligible_total)::integer AS floor_cents,
        (v_voucher_discount::numeric * eligible_cents / v_eligible_total)
          - floor(v_voucher_discount::numeric * eligible_cents / v_eligible_total) AS remainder
      FROM eligible WHERE eligible_cents > 0
    ), ranked AS (
      SELECT *, row_number() OVER (ORDER BY remainder DESC, position, line_id) AS remainder_rank,
        v_voucher_discount - sum(floor_cents) OVER () AS cents_left
      FROM shares
    )
    SELECT coalesce(pg_catalog.jsonb_object_agg(
      position::text,
      floor_cents + CASE WHEN remainder_rank <= cents_left THEN 1 ELSE 0 END
    ), '{}'::jsonb)
    INTO v_voucher_allocations
    FROM ranked;
  END IF;

  v_remaining := v_voucher_discount;
  FOR v_line IN
    SELECT value FROM pg_catalog.jsonb_array_elements(v_lines)
    ORDER BY (value->>'position')::integer
  LOOP
    v_email_alloc := CASE WHEN (v_line->>'position')::integer = 0 THEN v_email ELSE 0 END;
    v_service_pre := greatest(0, (v_line->>'service_pre_voucher_cents')::integer - v_email_alloc);
    v_addon_pre := (v_line->>'addon_pre_voucher_cents')::integer;
    v_is_eligible := v_voucher_id IS NOT NULL AND (
      coalesce(pg_catalog.cardinality(v_voucher.applicable_service_ids), 0) = 0
      OR (v_line->>'service_id')::uuid = ANY(v_voucher.applicable_service_ids)
    ) AND (
      v_voucher.applicable_service_category IS NULL
      OR v_line->>'service_category' = v_voucher.applicable_service_category
    );
    IF v_voucher.free_service_id IS NOT NULL THEN
      v_voucher_alloc := CASE
        WHEN NOT v_free_applied AND v_is_eligible
          AND (v_line->>'service_id')::uuid = v_voucher.free_service_id
        THEN least(v_service_pre, v_remaining) ELSE 0 END;
      IF v_voucher_alloc > 0 THEN v_free_applied := true; END IF;
    ELSE
      v_voucher_alloc := CASE WHEN v_is_eligible
        THEN coalesce((v_voucher_allocations->>(v_line->>'position'))::integer, 0)
        ELSE 0 END;
    END IF;
    v_remaining := v_remaining - v_voucher_alloc;
    v_final_service := v_service_pre - least(v_service_pre, v_voucher_alloc);
    v_final_addon := v_addon_pre - greatest(0, v_voucher_alloc - v_service_pre);
    v_line_subtotal := v_final_service + v_final_addon;
    v_subtotal := v_subtotal + v_line_subtotal;
    v_final_lines := v_final_lines || pg_catalog.jsonb_build_array(
      v_line || pg_catalog.jsonb_build_object(
        'email_discount_cents', v_email_alloc,
        'voucher_discount_cents', v_voucher_alloc,
        'service_price_cents', v_final_service,
        'addon_price_cents', v_final_addon,
        'pre_voucher_subtotal_cents', v_service_pre + v_addon_pre,
        'subtotal_cents', v_line_subtotal,
        'tax_cents', 0,
        'tax_amount_cents', 0,
        'total_cents', v_line_subtotal,
        'tax_breakdown', '[]'::jsonb
      )
    );
  END LOOP;
  IF v_remaining <> 0 OR v_subtotal <> v_pre_voucher - v_voucher_discount THEN
    RAISE EXCEPTION 'sequence voucher allocation invariant failed';
  END IF;

  FOR v_tax_line IN SELECT value FROM pg_catalog.jsonb_array_elements(v_tax_lines)
  LOOP
    IF pg_catalog.jsonb_typeof(v_tax_line) <> 'object'
       OR nullif(trim(v_tax_line->>'name'), '') IS NULL
       OR v_tax_line->'rate' IS NULL
       OR pg_catalog.jsonb_typeof(v_tax_line->'rate') <> 'number' THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'pricing_config_invalid');
    END IF;
    v_tax_rate := (v_tax_line->>'rate')::numeric;
    v_tax_enabled := coalesce((v_tax_line->>'enabled')::boolean, true);
    IF v_tax_rate < 0 OR v_tax_rate > 1 THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'pricing_config_invalid');
    END IF;
    IF v_tax_enabled AND v_tax_rate > 0 THEN
      v_tax_line_amount := round(v_subtotal::numeric * v_tax_rate)::integer;
      SELECT coalesce(sum(floor((l.value->>'subtotal_cents')::numeric * v_tax_rate)), 0)::integer
      INTO v_tax_floor_sum
      FROM pg_catalog.jsonb_array_elements(v_final_lines) l(value);
      v_tax_remainder_count := v_tax_line_amount - v_tax_floor_sum;
      WITH shares AS (
        SELECT l.value,
          (l.value->>'position')::integer AS position,
          floor((l.value->>'subtotal_cents')::numeric * v_tax_rate)::integer AS floor_cents,
          row_number() OVER (ORDER BY
            ((l.value->>'subtotal_cents')::numeric * v_tax_rate
              - floor((l.value->>'subtotal_cents')::numeric * v_tax_rate)) DESC,
            (l.value->>'position')::integer) AS remainder_rank
        FROM pg_catalog.jsonb_array_elements(v_final_lines) l(value)
      ), allocated AS (
        SELECT value, position, floor_cents + CASE
          WHEN remainder_rank <= v_tax_remainder_count THEN 1 ELSE 0 END AS amount_cents
        FROM shares
      )
      SELECT coalesce(pg_catalog.jsonb_agg(
        a.value || pg_catalog.jsonb_build_object(
          'tax_cents', (a.value->>'tax_cents')::integer + a.amount_cents,
          'tax_amount_cents', (a.value->>'tax_amount_cents')::integer + a.amount_cents,
          'total_cents', (a.value->>'total_cents')::integer + a.amount_cents,
          'tax_breakdown', a.value->'tax_breakdown' || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('name', trim(v_tax_line->>'name'),
              'rate', v_tax_rate, 'amount_cents', a.amount_cents)
          )
        ) ORDER BY a.position
      ), '[]'::jsonb) INTO v_final_lines FROM allocated a;
      v_tax := v_tax + v_tax_line_amount;
      v_tax_breakdown := v_tax_breakdown || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object('name', trim(v_tax_line->>'name'),
          'rate', v_tax_rate, 'amount_cents', v_tax_line_amount)
      );
    END IF;
  END LOOP;
  v_total := v_subtotal + v_tax;

  SELECT coalesce(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'line_id', l.value->'line_id',
      'position', (l.value->>'position')::integer,
      'service_id', l.value->'service_id',
      'requested_timing_preference', l.value->'requested_timing_preference',
      'resolved_timing_mode', l.value->'resolved_timing_mode',
      'resolved_staff_id', l.value->'resolved_staff_id',
      'resolved_resource_id', l.value->'resolved_resource_id',
      'prep_minutes', (l.value->>'prep_minutes')::integer,
      'duration_minutes', (l.value->>'duration_minutes')::integer,
      'buffer_minutes', (l.value->>'buffer_minutes')::integer,
      'occupied_start_utc', l.value->'occupied_start_utc',
      'service_start_utc', l.value->'service_start_utc',
      'service_end_utc', l.value->'service_end_utc',
      'occupied_end_utc', l.value->'occupied_end_utc'
    ) ORDER BY (l.value->>'position')::integer
  ), '[]'::jsonb)
  INTO v_timing_segments
  FROM pg_catalog.jsonb_array_elements(v_final_lines) l(value);

  v_material := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'schedule_model', 'segments_v1',
    'sequence_version', 1,
    'salon_id', v_salon_id,
    'requested_start_time_utc', v_requested_start,
    'parent_start_time_utc', (
      SELECT min((line.value->>'customer_start_utc')::timestamptz)
      FROM pg_catalog.jsonb_array_elements(v_final_lines) line(value)
    ),
    'parent_end_time_utc', (
      SELECT max((line.value->>'customer_end_utc')::timestamptz)
      FROM pg_catalog.jsonb_array_elements(v_final_lines) line(value)
    ),
    'same_staff_for_all', v_same_staff,
    'voucher_id', v_voucher_id,
    'currency', v_currency,
    'original_price_cents', v_original,
    'promo_discount_cents', v_promo,
    'email_discount_cents', v_email,
    'voucher_discount_cents', v_voucher_discount,
    'pre_voucher_subtotal_cents', v_pre_voucher,
    'subtotal_cents', v_subtotal,
    'tax_cents', v_tax,
    'tax_amount_cents', v_tax,
    'total_cents', v_total,
    'tax_breakdown', v_tax_breakdown,
    'segments', v_final_lines,
    'timing_segments', v_timing_segments,
    'readiness', pg_catalog.jsonb_build_object(
      'contract_version', 1,
      'schedule_model', 'segments_v1',
      'platform_enabled', true,
      'salon_enabled', true,
      'qa_allowlisted', true,
      'catalog_ready', true,
      'capacity_contract_ready', true,
      'payment_policy_ready', true,
      'ready', true
    )
  );
  v_fingerprint := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_material::text, 'UTF8'), 'sha256'), 'hex'
  );
  RETURN pg_catalog.jsonb_build_object(
    'success', true, 'code', 'quoted',
    'request_id', v_request_id,
    'pricing_fingerprint', v_fingerprint
  ) || v_material;
EXCEPTION
  WHEN exclusion_violation THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'slot_conflict');
  WHEN invalid_text_representation THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_line');
END;
$sequence_resolver$;

REVOKE ALL ON FUNCTION public.resolve_booking_sequence_pricing_and_schedule(jsonb, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_booking_sequence_pricing_and_schedule(jsonb, boolean)
  TO service_role;
