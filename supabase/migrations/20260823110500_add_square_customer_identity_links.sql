-- Bind Square customers to NailIQ profiles inside the provider account that
-- owns the identifier. client_profiles remains the global, canonical-phone
-- identity; this table replaces the legacy assumption that a Square customer
-- id is globally unique across every merchant and environment.

CREATE TABLE public.square_customer_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_environment text NOT NULL
    CHECK (provider_environment IN ('sandbox', 'production')),
  provider_merchant_id text NOT NULL
    CHECK (
      provider_merchant_id = btrim(provider_merchant_id)
      AND length(provider_merchant_id) BETWEEN 1 AND 255
      AND provider_merchant_id !~ '[[:cntrl:]]'
    ),
  square_customer_id text NOT NULL
    CHECK (
      square_customer_id = btrim(square_customer_id)
      AND length(square_customer_id) BETWEEN 1 AND 255
      AND square_customer_id !~ '[[:cntrl:]]'
    ),
  client_profile_id uuid NOT NULL
    REFERENCES public.client_profiles(id) ON DELETE RESTRICT,
  first_seen_salon_id uuid
    REFERENCES public.salons(id) ON DELETE SET NULL,
  first_seen_location_id text NOT NULL
    CHECK (
      first_seen_location_id = btrim(first_seen_location_id)
      AND length(first_seen_location_id) BETWEEN 1 AND 255
      AND first_seen_location_id !~ '[[:cntrl:]]'
    ),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT square_customer_identity_provider_key
    UNIQUE (
      provider_environment,
      provider_merchant_id,
      square_customer_id
    )
);

CREATE INDEX square_customer_identities_profile_idx
  ON public.square_customer_identities (client_profile_id);
CREATE INDEX square_customer_identities_first_seen_salon_idx
  ON public.square_customer_identities (first_seen_salon_id)
  WHERE first_seen_salon_id IS NOT NULL;

ALTER TABLE public.square_customer_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.square_customer_identities FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.square_customer_identities
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.square_customer_identities TO service_role;

COMMENT ON TABLE public.square_customer_identities IS
  'Service-only Square customer identity map. Square customer ids are scoped by environment and merchant; customer consent remains on client_profiles and is never accepted by the resolver.';
COMMENT ON COLUMN public.client_profiles.square_customer_id IS
  'Legacy unscoped Square customer id retained for compatibility only. New Square sync writes use square_customer_identities.';

-- Deliberately do not backfill the legacy unscoped
-- client_profiles.square_customer_id value. Salon membership proves that a
-- profile belongs to a tenant, but it does not prove which Square merchant
-- issued an old provider id. Each legacy link is therefore rebuilt lazily from
-- an authenticated customer read against the salon's exact Square account.

CREATE FUNCTION public.resolve_square_customer_identity(
  p_salon_id uuid,
  p_provider_environment text,
  p_provider_merchant_id text,
  p_provider_location_id text,
  p_square_customer_id text,
  p_phone text DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_email text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_integration public.square_integrations%ROWTYPE;
  v_identity public.square_customer_identities%ROWTYPE;
  v_profile public.client_profiles%ROWTYPE;
  v_environment text := lower(btrim(coalesce(p_provider_environment, '')));
  v_merchant_id text := btrim(coalesce(p_provider_merchant_id, ''));
  v_location_id text := btrim(coalesce(p_provider_location_id, ''));
  v_customer_id text := btrim(coalesce(p_square_customer_id, ''));
  v_phone text := nullif(public.canonical_phone(p_phone), '');
  v_name text := nullif(
    left(
      btrim(
        regexp_replace(
          regexp_replace(coalesce(p_name, ''), '[<>{}=&;]', ' ', 'g'),
          '[[:space:]]+',
          ' ',
          'g'
        )
      ),
      100
    ),
    ''
  );
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_created_profile boolean := false;
  v_salon_link_created boolean := false;
  v_rows integer := 0;
BEGIN
  IF v_role <> 'service_role' THEN
    RAISE EXCEPTION 'square_customer_identity_service_role_required'
      USING ERRCODE = '42501';
  END IF;

  IF v_environment NOT IN ('sandbox', 'production')
    OR length(v_merchant_id) NOT BETWEEN 1 AND 255
    OR v_merchant_id ~ '[[:cntrl:]]'
    OR length(v_location_id) NOT BETWEEN 1 AND 255
    OR v_location_id ~ '[[:cntrl:]]'
    OR length(v_customer_id) NOT BETWEEN 1 AND 255
    OR v_customer_id ~ '[[:cntrl:]]'
  THEN
    RAISE EXCEPTION 'square_customer_identity_input_invalid'
      USING ERRCODE = '22023';
  END IF;

  IF p_phone IS NULL AND (p_name IS NOT NULL OR p_email IS NOT NULL) THEN
    RAISE EXCEPTION 'square_customer_identity_material_incomplete'
      USING ERRCODE = '22023';
  END IF;
  IF v_phone IS NOT NULL AND v_phone !~ '^[0-9]{8,15}$' THEN
    RAISE EXCEPTION 'square_customer_identity_phone_invalid'
      USING ERRCODE = '22023';
  END IF;
  IF v_email IS NOT NULL
    AND (length(v_email) > 320 OR v_email ~ '[[:cntrl:]]')
  THEN
    RAISE EXCEPTION 'square_customer_identity_email_invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT si.*
  INTO v_integration
  FROM public.square_integrations si
  WHERE si.salon_id = p_salon_id
  FOR SHARE;
  IF NOT FOUND
    OR NOT v_integration.enabled
    OR NOT v_integration.sync_pull_create
    OR nullif(btrim(v_integration.access_token), '') IS NULL
    OR lower(btrim(v_integration.environment)) IS DISTINCT FROM v_environment
    OR btrim(v_integration.merchant_id) IS DISTINCT FROM v_merchant_id
    OR btrim(v_integration.location_id) IS DISTINCT FROM v_location_id
  THEN
    RAISE EXCEPTION 'square_customer_identity_context_mismatch'
      USING ERRCODE = '22023';
  END IF;

  -- Every caller acquires the provider lock before the phone lock. This fixed
  -- order makes exact replays and distinct-customer/same-phone dedup safe under
  -- concurrency without table-wide serialization.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'square-customer:' || v_environment || ':' || v_merchant_id || ':' || v_customer_id,
      0
    )
  );

  SELECT identity.*
  INTO v_identity
  FROM public.square_customer_identities identity
  WHERE identity.provider_environment = v_environment
    AND identity.provider_merchant_id = v_merchant_id
    AND identity.square_customer_id = v_customer_id
  FOR UPDATE;

  IF FOUND THEN
    SELECT profile.*
    INTO v_profile
    FROM public.client_profiles profile
    WHERE profile.id = v_identity.client_profile_id
    FOR UPDATE;
    IF NOT FOUND OR v_profile.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'square_customer_identity_profile_unavailable'
        USING ERRCODE = '23503';
    END IF;
    IF v_phone IS NOT NULL
      AND public.canonical_phone(v_profile.phone) IS DISTINCT FROM v_phone
    THEN
      RAISE EXCEPTION 'square_customer_identity_phone_conflict'
        USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.salon_clients (
      salon_id,
      client_profile_id,
      source,
      external_ref
    ) VALUES (
      p_salon_id,
      v_profile.id,
      'square',
      v_customer_id
    )
    ON CONFLICT (salon_id, client_profile_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_salon_link_created := v_rows = 1;

    RETURN pg_catalog.jsonb_build_object(
      'code', CASE WHEN v_salon_link_created THEN 'linked_salon' ELSE 'replayed' END,
      'client_profile_id', v_profile.id,
      'name', v_profile.name,
      'phone', v_profile.phone,
      'created_profile', false,
      'salon_link_created', v_salon_link_created
    );
  END IF;

  IF v_phone IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'code', 'not_found',
      'client_profile_id', NULL,
      'name', NULL,
      'phone', NULL,
      'created_profile', false,
      'salon_link_created', false
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('client-phone:' || v_phone, 0)
  );

  INSERT INTO public.client_profiles (phone, name, email)
  VALUES (v_phone, v_name, v_email)
  ON CONFLICT (phone) DO NOTHING
  RETURNING * INTO v_profile;
  v_created_profile := FOUND;

  IF NOT v_created_profile THEN
    SELECT profile.*
    INTO v_profile
    FROM public.client_profiles profile
    WHERE profile.phone = v_phone
    FOR UPDATE;
    IF NOT FOUND OR v_profile.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'square_customer_identity_profile_unavailable'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  INSERT INTO public.square_customer_identities (
    provider_environment,
    provider_merchant_id,
    square_customer_id,
    client_profile_id,
    first_seen_salon_id,
    first_seen_location_id
  ) VALUES (
    v_environment,
    v_merchant_id,
    v_customer_id,
    v_profile.id,
    p_salon_id,
    v_location_id
  )
  ON CONFLICT (
    provider_environment,
    provider_merchant_id,
    square_customer_id
  ) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 THEN
    SELECT identity.*
    INTO v_identity
    FROM public.square_customer_identities identity
    WHERE identity.provider_environment = v_environment
      AND identity.provider_merchant_id = v_merchant_id
      AND identity.square_customer_id = v_customer_id
    FOR UPDATE;
    IF NOT FOUND OR v_identity.client_profile_id IS DISTINCT FROM v_profile.id THEN
      RAISE EXCEPTION 'square_customer_identity_binding_conflict'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  INSERT INTO public.salon_clients (
    salon_id,
    client_profile_id,
    source,
    external_ref
  ) VALUES (
    p_salon_id,
    v_profile.id,
    'square',
    v_customer_id
  )
  ON CONFLICT (salon_id, client_profile_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  v_salon_link_created := v_rows = 1;

  RETURN pg_catalog.jsonb_build_object(
    'code', CASE WHEN v_created_profile THEN 'created_profile' ELSE 'linked_profile' END,
    'client_profile_id', v_profile.id,
    'name', v_profile.name,
    'phone', v_profile.phone,
    'created_profile', v_created_profile,
    'salon_link_created', v_salon_link_created
  );
END
$$;

REVOKE ALL ON FUNCTION public.resolve_square_customer_identity(
  uuid, text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_square_customer_identity(
  uuid, text, text, text, text, text, text, text
) TO service_role;

DO $proof$
DECLARE
  v_table oid := 'public.square_customer_identities'::regclass;
  v_function regprocedure := 'public.resolve_square_customer_identity(uuid,text,text,text,text,text,text,text)'::regprocedure;
  v_rls boolean;
  v_force_rls boolean;
BEGIN
  SELECT relrowsecurity, relforcerowsecurity
  INTO v_rls, v_force_rls
  FROM pg_catalog.pg_class
  WHERE oid = v_table;

  IF NOT v_rls
    OR NOT v_force_rls
    OR has_table_privilege('anon', v_table, 'SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('authenticated', v_table, 'SELECT,INSERT,UPDATE,DELETE')
    OR NOT has_table_privilege('service_role', v_table, 'SELECT')
    OR has_table_privilege('service_role', v_table, 'INSERT,UPDATE,DELETE')
    OR has_function_privilege('anon', v_function, 'EXECUTE')
    OR has_function_privilege('authenticated', v_function, 'EXECUTE')
    OR NOT has_function_privilege('service_role', v_function, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'square customer identity boundary mismatch';
  END IF;
END
$proof$;
