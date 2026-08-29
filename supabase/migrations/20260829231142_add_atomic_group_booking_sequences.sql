-- Group x multi-service Phase 2A: authoritative whole-party quote contract.
--
-- This migration is additive and default-off. It deliberately does NOT add a
-- create/commit RPC yet: readiness reports atomic_commit_ready=false, so no
-- salon can expose or commit this flow until Phase 2B proves organizer-only
-- OTP consumption, all-member rollback, replay, and management lifecycle.

ALTER TABLE public.salon_resources
  ADD COLUMN IF NOT EXISTS adjacency_group text;

DO $adjacency_group_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public.salon_resources'::regclass
      AND c.conname = 'salon_resources_adjacency_group_check'
  ) THEN
    ALTER TABLE public.salon_resources
      ADD CONSTRAINT salon_resources_adjacency_group_check CHECK (
        adjacency_group IS NULL
        OR (
          length(pg_catalog.btrim(adjacency_group)) BETWEEN 1 AND 64
          AND adjacency_group = pg_catalog.btrim(adjacency_group)
          AND adjacency_group ~ '^[A-Za-z0-9][A-Za-z0-9 _-]*$'
        )
      );
  END IF;
END;
$adjacency_group_constraint$;

COMMENT ON COLUMN public.salon_resources.adjacency_group IS
  'Optional salon-owned topology label. Sit-together is proven only when distinct first-service resources share this non-empty group; names/order are never inferred.';

INSERT INTO public.platform_flags (key, enabled, description)
VALUES (
  'feature_group_multi_service_booking',
  false,
  'Default-off group x multi-service quote/commit rollout. This flag never authorizes payment or notification dispatch.'
)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.load_public_group_sequence_readiness(
  p_salon_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO ''
AS $group_sequence_readiness$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_group_enabled boolean := false;
  v_salon_enabled boolean := false;
  v_platform_enabled boolean := false;
  v_sequence jsonb;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'unauthorized'
    );
  END IF;

  SELECT
    s.feature_flags->'group_booking_enabled' = 'true'::jsonb,
    s.feature_flags->'group_multi_service_booking_enabled' = 'true'::jsonb
  INTO v_group_enabled, v_salon_enabled
  FROM public.salons s
  WHERE s.id = p_salon_id AND s.archived_at IS NULL;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'not_found');
  END IF;

  SELECT coalesce(p.enabled, false)
  INTO v_platform_enabled
  FROM public.platform_flags p
  WHERE p.key = 'feature_group_multi_service_booking';
  v_platform_enabled := coalesce(v_platform_enabled, false);

  v_sequence := public.load_public_booking_sequence_readiness(p_salon_id);
  IF coalesce(v_sequence->>'success', 'false') <> 'true' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'sequence_readiness_unavailable'
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'code', 'loaded',
    'contract_version', 1,
    'schedule_model', 'group_segments_v1',
    'platform_enabled', v_platform_enabled,
    'salon_enabled', coalesce(v_salon_enabled, false),
    'group_booking_enabled', coalesce(v_group_enabled, false),
    'multi_service_ready', coalesce((v_sequence->>'ready')::boolean, false),
    'payment_policy_ready', coalesce(
      (v_sequence->>'payment_policy_ready')::boolean,
      false
    ),
    'resource_topology_supported', EXISTS (
      SELECT 1
      FROM public.salon_resources r
      WHERE r.salon_id = p_salon_id
        AND r.status = 'active'
        AND r.deleted_at IS NULL
        AND nullif(pg_catalog.btrim(r.adjacency_group), '') IS NOT NULL
    ),
    'quote_ready', v_platform_enabled
      AND coalesce(v_salon_enabled, false)
      AND coalesce(v_group_enabled, false)
      AND coalesce((v_sequence->>'ready')::boolean, false),
    'atomic_commit_ready', false,
    'ready', false
  );
END;
$group_sequence_readiness$;

REVOKE ALL ON FUNCTION public.load_public_group_sequence_readiness(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.load_public_group_sequence_readiness(uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_public_group_sequence_quote(
  p_request jsonb,
  p_lock_claims boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path TO ''
AS $group_sequence_quote$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_salon_id uuid;
  v_group_request_id uuid;
  v_requested_anchor timestamptz;
  v_seat_together boolean;
  v_apply_email_discount boolean;
  v_organizer jsonb;
  v_organizer_name text;
  v_organizer_phone text;
  v_organizer_email text;
  v_members jsonb;
  v_member jsonb;
  v_customer jsonb;
  v_member_index integer;
  v_member_request_id uuid;
  v_member_start timestamptz;
  v_member_phone text;
  v_member_email text;
  v_same_staff boolean;
  v_sequence_request jsonb;
  v_sequence_quote jsonb;
  v_member_quotes jsonb := '[]'::jsonb;
  v_existing_member jsonb;
  v_existing_segment jsonb;
  v_new_segment jsonb;
  v_member_count integer;
  v_line_count integer := 0;
  v_original integer := 0;
  v_promo integer := 0;
  v_email integer := 0;
  v_pre_voucher integer := 0;
  v_subtotal integer := 0;
  v_tax integer := 0;
  v_total integer := 0;
  v_readiness jsonb;
  v_material jsonb;
  v_fingerprint text;
  v_distinct_resources integer;
  v_adjacency_groups integer;
  v_missing_topology integer;
  v_min_start timestamptz;
  v_max_start timestamptz;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_request IS NULL
     OR pg_catalog.jsonb_typeof(p_request) IS DISTINCT FROM 'object'
     OR (p_request - ARRAY[
       'contract_version', 'salon_id', 'group_request_id',
       'requested_anchor_utc', 'seat_together', 'organizer', 'members',
       'apply_email_discount'
     ]::text[]) <> '{}'::jsonb THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
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
    v_requested_anchor := (p_request->>'requested_anchor_utc')::timestamptz;
    v_seat_together := coalesce((p_request->>'seat_together')::boolean, false);
    v_apply_email_discount := coalesce(
      (p_request->>'apply_email_discount')::boolean,
      false
    );
  EXCEPTION
    WHEN invalid_text_representation OR invalid_datetime_format
      OR datetime_field_overflow THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
  END;

  v_organizer := p_request->'organizer';
  v_members := p_request->'members';
  IF pg_catalog.jsonb_typeof(v_organizer) IS DISTINCT FROM 'object'
     OR (v_organizer - ARRAY['name', 'phone', 'email']::text[]) <> '{}'::jsonb
     OR pg_catalog.jsonb_typeof(v_members) IS DISTINCT FROM 'array' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
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
  v_member_count := pg_catalog.jsonb_array_length(v_members);
  IF v_salon_id IS NULL
     OR v_group_request_id IS NULL
     OR v_requested_anchor IS NULL
     OR length(v_organizer_name) NOT BETWEEN 1 AND 120
     OR v_organizer_name ~ '[<>{}=&;]'
     OR length(v_organizer_phone) NOT BETWEEN 7 AND 15
     OR (v_organizer_email IS NOT NULL AND (
       length(v_organizer_email) > 254
       OR v_organizer_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     ))
     OR v_member_count NOT BETWEEN 2 AND 20 THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_input');
  END IF;

  v_readiness := public.load_public_group_sequence_readiness(v_salon_id);
  IF coalesce(v_readiness->>'success', 'false') <> 'true'
     OR coalesce((v_readiness->>'quote_ready')::boolean, false) IS NOT TRUE THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'code', 'feature_disabled',
      'readiness', v_readiness
    );
  END IF;

  IF p_lock_claims THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'group-sequence-capacity:' || v_salon_id::text,
        0
      )
    );
  END IF;

  FOR v_member IN
    SELECT e.value
    FROM pg_catalog.jsonb_array_elements(v_members)
      WITH ORDINALITY AS e(value, ordinality)
    ORDER BY e.ordinality
  LOOP
    IF pg_catalog.jsonb_typeof(v_member) IS DISTINCT FROM 'object'
       OR (v_member - ARRAY[
         'member_index', 'member_request_id', 'requested_start_time_utc',
         'customer', 'lines', 'same_staff_for_all'
       ]::text[]) <> '{}'::jsonb THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_member');
    END IF;
    BEGIN
      v_member_index := (v_member->>'member_index')::integer;
      v_member_request_id := (v_member->>'member_request_id')::uuid;
      v_member_start := (v_member->>'requested_start_time_utc')::timestamptz;
      v_same_staff := coalesce(
        (v_member->>'same_staff_for_all')::boolean,
        false
      );
    EXCEPTION
      WHEN invalid_text_representation OR invalid_datetime_format
        OR datetime_field_overflow THEN
        RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_member');
    END;
    IF v_member_index IS DISTINCT FROM pg_catalog.jsonb_array_length(v_member_quotes)
       OR v_member_request_id IS NULL
       OR v_member_start IS NULL
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.jsonb_array_elements(v_member_quotes) prior(value)
         WHERE prior.value->>'member_request_id' = v_member_request_id::text
       ) THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'invalid_member_order'
      );
    END IF;
    v_customer := v_member->'customer';
    IF pg_catalog.jsonb_typeof(v_customer) IS DISTINCT FROM 'object'
       OR (v_customer - ARRAY['name', 'phone', 'email']::text[]) <> '{}'::jsonb
       OR length(pg_catalog.btrim(coalesce(v_customer->>'name', ''))) NOT BETWEEN 1 AND 120
       OR pg_catalog.btrim(v_customer->>'name') ~ '[<>{}=&;]' THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_member');
    END IF;
    v_member_phone := pg_catalog.regexp_replace(
      coalesce(v_customer->>'phone', ''),
      '\D',
      '',
      'g'
    );
    v_member_email := nullif(
      lower(pg_catalog.btrim(coalesce(v_customer->>'email', ''))),
      ''
    );
    IF (v_member_phone <> '' AND length(v_member_phone) NOT BETWEEN 7 AND 15)
       OR (v_member_email IS NOT NULL AND (
         length(v_member_email) > 254
         OR v_member_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
       )) THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'invalid_member_contact'
      );
    END IF;
    IF v_member_index = 0 AND (
         pg_catalog.btrim(v_customer->>'name') IS DISTINCT FROM v_organizer_name
         OR v_member_phone IS DISTINCT FROM v_organizer_phone
         OR v_member_email IS DISTINCT FROM v_organizer_email
       ) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'organizer_mismatch');
    END IF;
    IF pg_catalog.jsonb_typeof(v_member->'lines') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(v_member->'lines') NOT BETWEEN 1 AND 5 THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_member');
    END IF;
    v_line_count := v_line_count + pg_catalog.jsonb_array_length(v_member->'lines');
    IF v_line_count > 40 THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'too_many_service_lines'
      );
    END IF;

    -- The organizer phone is scheduling-only identity for contactless guests.
    -- Guest phone/profile material is never copied into the quote or persisted
    -- by this read-only resolver. Email incentive belongs to member 0 only.
    v_sequence_request := pg_catalog.jsonb_build_object(
      'contract_version', 1,
      'salon_id', v_salon_id,
      'request_id', v_member_request_id,
      'requested_start_time_utc', v_member_start,
      'lines', v_member->'lines',
      'same_staff_for_all', v_same_staff,
      'voucher_code', NULL,
      'customer', pg_catalog.jsonb_build_object(
        'name', pg_catalog.btrim(v_customer->>'name'),
        'phone', v_organizer_phone,
        'email', CASE WHEN v_member_index = 0 THEN v_organizer_email ELSE NULL END
      ),
      'apply_email_discount', v_member_index = 0 AND v_apply_email_discount
    );
    v_sequence_quote := public.resolve_booking_sequence_pricing_and_schedule(
      v_sequence_request,
      p_lock_claims
    );
    IF coalesce(v_sequence_quote->>'success', 'false') <> 'true' THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'member_quote_failed',
        'member_index', v_member_index,
        'member_code', v_sequence_quote->>'code'
      );
    END IF;

    FOR v_new_segment IN
      SELECT n.value
      FROM pg_catalog.jsonb_array_elements(
        v_sequence_quote->'timing_segments'
      ) n(value)
    LOOP
      FOR v_existing_member IN
        SELECT m.value
        FROM pg_catalog.jsonb_array_elements(v_member_quotes) m(value)
      LOOP
        FOR v_existing_segment IN
          SELECT s.value
          FROM pg_catalog.jsonb_array_elements(
            v_existing_member->'quote'->'timing_segments'
          ) s(value)
        LOOP
          IF (
            v_existing_segment->>'resolved_staff_id'
              = v_new_segment->>'resolved_staff_id'
            OR (
              nullif(v_existing_segment->>'resolved_resource_id', '') IS NOT NULL
              AND v_existing_segment->>'resolved_resource_id'
                = v_new_segment->>'resolved_resource_id'
            )
          ) AND pg_catalog.tstzrange(
            (v_existing_segment->>'occupied_start_utc')::timestamptz,
            (v_existing_segment->>'occupied_end_utc')::timestamptz,
            '[)'
          ) && pg_catalog.tstzrange(
            (v_new_segment->>'occupied_start_utc')::timestamptz,
            (v_new_segment->>'occupied_end_utc')::timestamptz,
            '[)'
          ) THEN
            RETURN pg_catalog.jsonb_build_object(
              'success', false,
              'code', 'group_slot_conflict',
              'member_indexes', pg_catalog.jsonb_build_array(
                (v_existing_member->>'member_index')::integer,
                v_member_index
              )
            );
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;

    v_original := v_original + (v_sequence_quote->>'original_price_cents')::integer;
    v_promo := v_promo + (v_sequence_quote->>'promo_discount_cents')::integer;
    v_email := v_email + (v_sequence_quote->>'email_discount_cents')::integer;
    v_pre_voucher := v_pre_voucher
      + (v_sequence_quote->>'pre_voucher_subtotal_cents')::integer;
    v_subtotal := v_subtotal + (v_sequence_quote->>'subtotal_cents')::integer;
    v_tax := v_tax + (v_sequence_quote->>'tax_cents')::integer;
    v_total := v_total + (v_sequence_quote->>'total_cents')::integer;
    v_member_quotes := v_member_quotes || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'member_index', v_member_index,
        'member_request_id', v_member_request_id,
        'quote', v_sequence_quote
      )
    );
  END LOOP;

  IF v_line_count < v_member_count THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'invalid_member');
  END IF;

  IF v_seat_together THEN
    SELECT
      count(DISTINCT first_segment->>'resolved_resource_id'),
      count(DISTINCT r.adjacency_group),
      count(*) FILTER (
        WHERE nullif(pg_catalog.btrim(r.adjacency_group), '') IS NULL
      ),
      min((first_segment->>'service_start_utc')::timestamptz),
      max((first_segment->>'service_start_utc')::timestamptz)
    INTO v_distinct_resources, v_adjacency_groups, v_missing_topology,
      v_min_start, v_max_start
    FROM pg_catalog.jsonb_array_elements(v_member_quotes) member(value)
    CROSS JOIN LATERAL (
      SELECT member.value->'quote'->'timing_segments'->0 AS first_segment
    ) first_line
    LEFT JOIN public.salon_resources r
      ON r.id = nullif(first_segment->>'resolved_resource_id', '')::uuid
      AND r.salon_id = v_salon_id
      AND r.status = 'active'
      AND r.deleted_at IS NULL;
    IF v_distinct_resources <> v_member_count
       OR v_adjacency_groups <> 1
       OR v_missing_topology <> 0
       OR v_max_start - v_min_start > interval '30 minutes' THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'code', 'seat_together_unproven'
      );
    END IF;
  END IF;

  v_material := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'schedule_model', 'group_segments_v1',
    'salon_id', v_salon_id,
    'group_request_id', v_group_request_id,
    'requested_anchor_utc', v_requested_anchor,
    'seat_together', v_seat_together,
    'member_count', v_member_count,
    'service_line_count', v_line_count,
    'original_price_cents', v_original,
    'promo_discount_cents', v_promo,
    'email_discount_cents', v_email,
    'voucher_discount_cents', 0,
    'pre_voucher_subtotal_cents', v_pre_voucher,
    'subtotal_cents', v_subtotal,
    'tax_cents', v_tax,
    'tax_amount_cents', v_tax,
    'total_cents', v_total,
    'member_quotes', v_member_quotes,
    'readiness', v_readiness
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
$group_sequence_quote$;

REVOKE ALL ON FUNCTION public.resolve_public_group_sequence_quote(jsonb, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_public_group_sequence_quote(jsonb, boolean)
  TO service_role;

CREATE OR REPLACE FUNCTION public.quote_public_group_booking_sequences(
  p_request jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path TO ''
AS $group_sequence_quote_wrapper$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  RETURN public.resolve_public_group_sequence_quote(p_request, false);
END;
$group_sequence_quote_wrapper$;

REVOKE ALL ON FUNCTION public.quote_public_group_booking_sequences(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_public_group_booking_sequences(jsonb)
  TO service_role;

COMMENT ON FUNCTION public.resolve_public_group_sequence_quote(jsonb, boolean) IS
  'Service-role-only authoritative whole-party multi-service quote resolver. It never writes bookings, consumes OTP, dispatches providers, or authorizes money movement.';
COMMENT ON FUNCTION public.quote_public_group_booking_sequences(jsonb) IS
  'Service-role-only read-only public wrapper for group x multi-service quote. Commit remains intentionally unavailable in Phase 2A.';

DO $group_sequence_quote_contract_proof$
DECLARE
  v_readiness regprocedure := pg_catalog.to_regprocedure(
    'public.load_public_group_sequence_readiness(uuid)'
  );
  v_resolver regprocedure := pg_catalog.to_regprocedure(
    'public.resolve_public_group_sequence_quote(jsonb,boolean)'
  );
  v_quote regprocedure := pg_catalog.to_regprocedure(
    'public.quote_public_group_booking_sequences(jsonb)'
  );
  v_target regprocedure;
  v_definition text;
BEGIN
  IF v_readiness IS NULL OR v_resolver IS NULL OR v_quote IS NULL THEN
    RAISE EXCEPTION 'group sequence quote contract signature missing';
  END IF;
  FOREACH v_target IN ARRAY ARRAY[v_readiness, v_resolver, v_quote]
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
      RAISE EXCEPTION 'group sequence quote ACL mismatch: %', v_target;
    END IF;
    SELECT pg_catalog.pg_get_functiondef(v_target::oid) INTO v_definition;
    IF pg_catalog.strpos(v_definition, 'SECURITY DEFINER') = 0
       OR pg_catalog.strpos(v_definition, 'SET search_path TO ''''') = 0 THEN
      RAISE EXCEPTION 'group sequence quote hardening mismatch: %', v_target;
    END IF;
  END LOOP;
  IF pg_catalog.to_regprocedure(
    'public.create_public_group_booking_sequences(jsonb)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 2A must not expose group sequence commit';
  END IF;
END;
$group_sequence_quote_contract_proof$;
