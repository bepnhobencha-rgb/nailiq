-- Controlled multi-service rollout for active/trialing salons.
--
-- This migration is additive and default-off. It does not enable the platform
-- gate or any salon gate, edit catalog/staff/policy data, or authorize deposits,
-- charges, refunds, notifications, or provider calls.

DO $multi_service_rollout_preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.platform_flags p
    WHERE p.key = 'feature_multi_service_booking' AND p.enabled IS TRUE
  ) OR EXISTS (
    SELECT 1 FROM public.salons s
    WHERE s.archived_at IS NULL
      AND s.feature_flags->'multi_service_booking_enabled' = 'true'::jsonb
  ) OR EXISTS (
    SELECT 1 FROM public.platform_settings ps
    WHERE ps.id = 'platform' AND ps.multi_service_booking_qa_salon_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'multi-service controlled rollout migration requires platform, salon, and legacy QA gates to be OFF';
  END IF;
END;
$multi_service_rollout_preflight$;

CREATE TABLE IF NOT EXISTS public.multi_service_booking_rollouts (
  salon_id uuid PRIMARY KEY
    REFERENCES public.salons(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  enabled_at timestamptz,
  last_changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  CONSTRAINT multi_service_booking_rollouts_enabled_material_check CHECK (
    (enabled IS TRUE AND enabled_at IS NOT NULL AND last_changed_by IS NOT NULL)
    OR (enabled IS FALSE AND enabled_at IS NULL)
  )
);

COMMENT ON TABLE public.multi_service_booking_rollouts IS
  'Private, RPC-only authorization ledger for controlled per-salon multi-service rollout. A row never authorizes money movement or provider dispatch.';

ALTER TABLE public.multi_service_booking_rollouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.multi_service_booking_rollouts FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.multi_service_booking_rollouts
  FROM PUBLIC, anon, authenticated, service_role;

DROP POLICY IF EXISTS multi_service_booking_rollouts_deny_direct_access
  ON public.multi_service_booking_rollouts;
CREATE POLICY multi_service_booking_rollouts_deny_direct_access
  ON public.multi_service_booking_rollouts
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.multi_service_booking_rollout_authorized(
  p_salon_id uuid
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO ''
AS $rollout_authorized$
  SELECT p_salon_id IS NOT NULL AND (
    EXISTS (
      SELECT 1
      FROM public.platform_settings ps
      WHERE ps.id = 'platform'
        AND ps.multi_service_booking_qa_salon_id = p_salon_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.multi_service_booking_rollouts r
      WHERE r.salon_id = p_salon_id
        AND r.enabled IS TRUE
    )
  );
$rollout_authorized$;

REVOKE ALL ON FUNCTION public.multi_service_booking_rollout_authorized(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.protect_multi_service_booking_rollout_flag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $protect_multi_service_flag$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_uid uuid := (SELECT auth.uid());
  v_old jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL
    ELSE OLD.feature_flags->'multi_service_booking_enabled' END;
  v_new jsonb := NEW.feature_flags->'multi_service_booking_enabled';
  v_legacy_qa uuid;
  v_production_authorized boolean := false;
  v_control_salon_id text := current_setting(
    'nailiq.multi_service_rollout_salon_id', true
  );
BEGIN
  IF v_old IS NOT DISTINCT FROM v_new THEN RETURN NEW; END IF;
  IF v_new IS NOT NULL AND pg_catalog.jsonb_typeof(v_new) <> 'boolean' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'multi-service flag must be JSON boolean';
  END IF;
  IF TG_OP = 'INSERT' AND coalesce(v_new, 'false'::jsonb) <> 'true'::jsonb THEN
    RETURN NEW;
  END IF;
  IF NOT (
    v_role = 'service_role'
    OR (v_role = '' AND session_user IN ('postgres', 'supabase_admin'))
    OR (v_role = 'authenticated' AND v_uid IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.superadmins sa WHERE sa.user_id = v_uid AND sa.revoked_at IS NULL
    ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'multi-service rollout flag requires SuperAdmin authorization';
  END IF;
  IF v_new = 'true'::jsonb THEN
    SELECT ps.multi_service_booking_qa_salon_id INTO v_legacy_qa
    FROM public.platform_settings ps WHERE ps.id = 'platform';
    SELECT EXISTS (
      SELECT 1 FROM public.multi_service_booking_rollouts r
      WHERE r.salon_id = NEW.id AND r.enabled IS TRUE
    ) INTO v_production_authorized;

    IF v_legacy_qa IS NOT DISTINCT FROM NEW.id THEN
      IF NEW.archived_at IS NOT NULL
         OR NEW.is_beta IS NOT TRUE
         OR lower(pg_catalog.btrim(NEW.name)) IN ('hi-lite head spa', 'hi-lite studio')
         OR lower(pg_catalog.btrim(NEW.slug)) IN ('hilite-anaheim', 'hilite-studio') THEN
        RAISE EXCEPTION USING ERRCODE = '42501',
          MESSAGE = 'multi-service Phase A may be enabled only for the configured disposable Salon QA';
      END IF;
    ELSIF NOT coalesce(v_production_authorized, false)
       OR v_control_salon_id IS DISTINCT FROM NEW.id::text
       OR NEW.archived_at IS NOT NULL
       OR NEW.subscription_status NOT IN ('active', 'trialing') THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'multi-service salon flag requires an active controlled-rollout authorization';
    END IF;
  END IF;
  RETURN NEW;
END;
$protect_multi_service_flag$;

REVOKE ALL ON FUNCTION public.protect_multi_service_booking_rollout_flag()
  FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the legacy single disposable QA RPC. Production salons use this
-- separate atomic RPC, so a generic salon flag editor cannot create rollout
-- authorization or bypass readiness.
CREATE OR REPLACE FUNCTION public.configure_multi_service_booking_rollout(
  p_salon_id uuid,
  p_enable boolean,
  p_confirmation text,
  p_actor_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $configure_multi_service_rollout$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_platform_enabled boolean := false;
  v_salon public.salons%ROWTYPE;
  v_readiness jsonb;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_enable IS NULL OR p_actor_user_id IS NULL
     OR p_confirmation IS DISTINCT FROM (CASE WHEN p_enable
       THEN 'ENABLE_MULTI_SERVICE_PRODUCTION'
       ELSE 'DISABLE_MULTI_SERVICE_PRODUCTION' END) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'confirmation_required');
  END IF;

  -- Match sequence-create lock order: salon/payment policy first, followed by
  -- platform state and finally the private rollout row.
  SELECT s.* INTO v_salon
  FROM public.salons s WHERE s.id = p_salon_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'not_found');
  END IF;
  PERFORM 1 FROM public.square_integrations sq
  WHERE sq.salon_id = p_salon_id FOR UPDATE;
  PERFORM p.key FROM public.platform_flags p
  WHERE p.key = 'feature_multi_service_booking' FOR UPDATE;
  SELECT coalesce(p.enabled, false) INTO v_platform_enabled
  FROM public.platform_flags p WHERE p.key = 'feature_multi_service_booking';
  PERFORM ps.id FROM public.platform_settings ps
  WHERE ps.id = 'platform' FOR UPDATE;
  INSERT INTO public.multi_service_booking_rollouts(
    salon_id, enabled, enabled_at, last_changed_by
  ) VALUES (p_salon_id, false, NULL, p_actor_user_id)
  ON CONFLICT (salon_id) DO NOTHING;
  PERFORM r.salon_id FROM public.multi_service_booking_rollouts r
  WHERE r.salon_id = p_salon_id FOR UPDATE;

  IF p_enable THEN
    IF NOT coalesce(v_platform_enabled, false) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'platform_disabled');
    END IF;
    IF v_salon.archived_at IS NOT NULL
       OR v_salon.subscription_status NOT IN ('active', 'trialing') THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'salon_not_active');
    END IF;

    BEGIN
      UPDATE public.multi_service_booking_rollouts r
      SET enabled = true,
          enabled_at = pg_catalog.transaction_timestamp(),
          last_changed_by = p_actor_user_id,
          updated_at = pg_catalog.transaction_timestamp()
      WHERE r.salon_id = p_salon_id;
      PERFORM pg_catalog.set_config(
        'nailiq.multi_service_rollout_salon_id', p_salon_id::text, true
      );
      UPDATE public.salons s
      SET feature_flags = pg_catalog.jsonb_set(
        coalesce(s.feature_flags, '{}'::jsonb),
        '{multi_service_booking_enabled}', 'true'::jsonb, true
      )
      WHERE s.id = p_salon_id;
      PERFORM pg_catalog.set_config(
        'nailiq.multi_service_rollout_salon_id', '', true
      );

      v_readiness := public.load_public_booking_sequence_readiness(p_salon_id);
      IF coalesce((v_readiness->>'ready')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION USING ERRCODE = 'NQ002',
          MESSAGE = 'multi-service production salon is not readiness-complete';
      END IF;
    EXCEPTION WHEN SQLSTATE 'NQ002' THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false, 'code', 'not_ready', 'salon_id', p_salon_id,
        'readiness', coalesce(v_readiness, '{}'::jsonb)
      );
    END;
    RETURN pg_catalog.jsonb_build_object(
      'success', true, 'code', 'enabled', 'salon_id', p_salon_id,
      'readiness', v_readiness
    );
  END IF;

  UPDATE public.salons s
  SET feature_flags = coalesce(s.feature_flags, '{}'::jsonb)
    - 'multi_service_booking_enabled'
  WHERE s.id = p_salon_id;
  UPDATE public.multi_service_booking_rollouts r
  SET enabled = false,
      enabled_at = NULL,
      last_changed_by = p_actor_user_id,
      updated_at = pg_catalog.transaction_timestamp()
  WHERE r.salon_id = p_salon_id;
  RETURN pg_catalog.jsonb_build_object(
    'success', true, 'code', 'disabled', 'salon_id', p_salon_id
  );
END;
$configure_multi_service_rollout$;

REVOKE ALL ON FUNCTION public.configure_multi_service_booking_rollout(uuid, boolean, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.configure_multi_service_booking_rollout(uuid, boolean, text, uuid)
  TO service_role;

-- Patch the deployed resolver and readiness definitions exactly. Abort on body
-- drift instead of silently weakening either allowlist check.
DO $multi_service_authorization_patch$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.resolve_booking_sequence_pricing_and_schedule(jsonb,boolean)'::regprocedure
  ) INTO v_definition;
  v_old := $old_initial$SELECT EXISTS (
    SELECT 1 FROM public.platform_settings ps
    WHERE ps.id = 'platform' AND ps.multi_service_booking_qa_salon_id = v_salon_id
  ) INTO v_qa_allowlisted;$old_initial$;
  v_new := $new_initial$SELECT public.multi_service_booking_rollout_authorized(v_salon_id)
  INTO v_qa_allowlisted;$new_initial$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    IF pg_catalog.strpos(v_definition, v_new) = 0 THEN
      RAISE EXCEPTION 'booking sequence resolver initial authorization guard drifted';
    END IF;
  ELSE
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  END IF;

  v_old := $old_locked$IF NOT EXISTS (SELECT 1 FROM public.platform_settings ps
      WHERE ps.id = 'platform' AND ps.multi_service_booking_qa_salon_id = v_salon_id) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'feature_disabled');
    END IF;$old_locked$;
  v_new := $new_locked$IF NOT public.multi_service_booking_rollout_authorized(v_salon_id) THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'feature_disabled');
    END IF;$new_locked$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    IF pg_catalog.strpos(v_definition, v_new) = 0 THEN
      RAISE EXCEPTION 'booking sequence resolver locked authorization guard drifted';
    END IF;
  ELSE
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  END IF;
  EXECUTE v_definition;

  SELECT pg_catalog.pg_get_functiondef(
    'public.load_public_booking_sequence_readiness(uuid)'::regprocedure
  ) INTO v_definition;
  v_old := $old_readiness$SELECT EXISTS (SELECT 1 FROM public.platform_settings ps
    WHERE ps.id = 'platform' AND ps.multi_service_booking_qa_salon_id = p_salon_id)
  INTO v_qa_allowlisted;$old_readiness$;
  v_new := $new_readiness$SELECT public.multi_service_booking_rollout_authorized(p_salon_id)
  INTO v_qa_allowlisted;$new_readiness$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    IF pg_catalog.strpos(v_definition, v_new) = 0 THEN
      RAISE EXCEPTION 'booking sequence readiness authorization guard drifted';
    END IF;
  ELSE
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  END IF;
  EXECUTE v_definition;
END;
$multi_service_authorization_patch$;

COMMENT ON FUNCTION public.configure_multi_service_booking_rollout(uuid, boolean, text, uuid) IS
  'Service-role-only atomic per-salon multi-service rollout control. Exact confirmation, active subscription, platform gate, and full readiness are mandatory; failure rolls back authorization and salon flag.';
