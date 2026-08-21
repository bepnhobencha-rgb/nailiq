-- Guided Admin Setup remains a single-salon disposable-QA prototype. This
-- migration removes the last generic SuperAdmin/service-role shortcut: the
-- tenant flag can become true only while the exact salon is atomically bound
-- in the platform singleton. It never enables a salon during deployment.

DO $guided_setup_rollout_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.platform_flags AS pf
    WHERE pf.key = 'feature_guided_admin_setup'
      AND pf.enabled IS TRUE
  ) THEN
    RAISE EXCEPTION
      'guided setup platform flag must be OFF before QA allowlist hardening';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.salons AS s
    WHERE s.feature_flags->'guided_admin_setup_enabled' = 'true'::jsonb
  ) THEN
    RAISE EXCEPTION
      'guided setup rollout must be disabled for every active salon before QA allowlist hardening';
  END IF;
END;
$guided_setup_rollout_preflight$;

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS guided_admin_setup_qa_salon_id uuid
    REFERENCES public.salons(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS platform_settings_guided_setup_qa_salon_idx
  ON public.platform_settings (guided_admin_setup_qa_salon_id)
  WHERE guided_admin_setup_qa_salon_id IS NOT NULL;

COMMENT ON COLUMN public.platform_settings.guided_admin_setup_qa_salon_id IS
  'Single disposable Salon QA allowlist for Guided Admin Setup. NULL blocks every salon even if a caller attempts to set its tenant flag.';

ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS guided_setup_integrations_skipped_at timestamptz;

COMMENT ON COLUMN public.salons.guided_setup_integrations_skipped_at IS
  'Optional Guided Setup decision. NULL means undecided; a timestamp records an explicit Owner/Admin Skip and never contributes to required readiness percentage.';

CREATE OR REPLACE FUNCTION public.protect_guided_admin_setup_rollout_flag()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $protect_guided_setup_flag$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_old jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL
    ELSE OLD.feature_flags->'guided_admin_setup_enabled' END;
  v_new jsonb := NEW.feature_flags->'guided_admin_setup_enabled';
  v_allowlisted uuid;
BEGIN
  IF v_old IS NOT DISTINCT FROM v_new THEN
    RETURN NEW;
  END IF;
  IF v_new IS NOT NULL AND pg_catalog.jsonb_typeof(v_new) <> 'boolean' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'guided admin setup flag must be JSON boolean';
  END IF;
  IF TG_OP = 'INSERT' AND coalesce(v_new, 'false'::jsonb) <> 'true'::jsonb THEN
    RETURN NEW;
  END IF;
  IF NOT (
    v_role = 'service_role'
    OR (v_role = '' AND session_user IN ('postgres', 'supabase_admin'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'guided admin setup rollout requires the dedicated QA setter';
  END IF;
  IF v_new = 'true'::jsonb THEN
    SELECT ps.guided_admin_setup_qa_salon_id
    INTO v_allowlisted
    FROM public.platform_settings AS ps
    WHERE ps.id = 'platform';

    IF v_allowlisted IS DISTINCT FROM NEW.id
       OR NEW.archived_at IS NOT NULL
       OR NEW.is_beta IS NOT TRUE
       OR NEW.subscription_status NOT IN ('active', 'trialing')
       OR lower(trim(NEW.name)) IN ('hi-lite head spa', 'hi-lite studio')
       OR lower(trim(NEW.slug)) IN ('hilite-anaheim', 'hilite-studio') THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'guided admin setup may be enabled only for the configured disposable Salon QA';
    END IF;
  END IF;
  RETURN NEW;
END;
$protect_guided_setup_flag$;

REVOKE ALL ON FUNCTION public.protect_guided_admin_setup_rollout_flag()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.configure_guided_admin_setup_qa_salon(
  p_salon_id uuid,
  p_enable boolean,
  p_confirmation text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $configure_guided_setup_qa_salon$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
  v_platform_enabled boolean := false;
  v_salon public.salons%ROWTYPE;
  v_allowlisted uuid;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_enable IS NULL
     OR p_confirmation IS DISTINCT FROM (CASE WHEN p_enable
       THEN 'ENABLE_GUIDED_ADMIN_SETUP_QA'
       ELSE 'DISABLE_GUIDED_ADMIN_SETUP_QA' END) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'confirmation_required'
    );
  END IF;

  -- Match every caller: platform feature -> singleton -> salon. A consistent
  -- lock order prevents two operators from splitting the singleton allowlist
  -- and tenant flag across concurrent requests.
  PERFORM pf.key
  FROM public.platform_flags AS pf
  WHERE pf.key = 'feature_guided_admin_setup'
  FOR UPDATE;
  SELECT coalesce(pf.enabled, false)
  INTO v_platform_enabled
  FROM public.platform_flags AS pf
  WHERE pf.key = 'feature_guided_admin_setup';

  INSERT INTO public.platform_settings(id)
  VALUES ('platform')
  ON CONFLICT (id) DO NOTHING;
  SELECT ps.guided_admin_setup_qa_salon_id
  INTO v_allowlisted
  FROM public.platform_settings AS ps
  WHERE ps.id = 'platform'
  FOR UPDATE;

  SELECT s.*
  INTO v_salon
  FROM public.salons AS s
  WHERE s.id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'code', 'not_found');
  END IF;

  IF p_enable THEN
    IF NOT coalesce(v_platform_enabled, false) THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false, 'code', 'platform_disabled'
      );
    END IF;
    IF v_allowlisted IS NOT NULL AND v_allowlisted IS DISTINCT FROM p_salon_id THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false, 'code', 'allowlist_conflict'
      );
    END IF;
    IF v_salon.archived_at IS NOT NULL
       OR v_salon.subscription_status NOT IN ('active', 'trialing')
       OR v_salon.is_beta IS NOT TRUE
       OR lower(trim(v_salon.name)) IN ('hi-lite head spa', 'hi-lite studio')
       OR lower(trim(v_salon.slug)) IN ('hilite-anaheim', 'hilite-studio') THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false, 'code', 'salon_not_disposable_qa'
      );
    END IF;

    UPDATE public.platform_settings AS ps
    SET guided_admin_setup_qa_salon_id = p_salon_id,
        updated_at = pg_catalog.transaction_timestamp()
    WHERE ps.id = 'platform';
    UPDATE public.salons AS s
    SET feature_flags = pg_catalog.jsonb_set(
      coalesce(s.feature_flags, '{}'::jsonb),
      '{guided_admin_setup_enabled}',
      'true'::jsonb,
      true
    )
    WHERE s.id = p_salon_id;
    RETURN pg_catalog.jsonb_build_object(
      'success', true, 'code', 'enabled', 'salon_id', p_salon_id
    );
  END IF;

  IF v_allowlisted IS NOT NULL AND v_allowlisted IS DISTINCT FROM p_salon_id THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'code', 'allowlist_conflict'
    );
  END IF;
  UPDATE public.salons AS s
  SET feature_flags = coalesce(s.feature_flags, '{}'::jsonb)
    - 'guided_admin_setup_enabled'
  WHERE s.id = p_salon_id;
  UPDATE public.platform_settings AS ps
  SET guided_admin_setup_qa_salon_id = NULL,
      updated_at = pg_catalog.transaction_timestamp()
  WHERE ps.id = 'platform'
    AND ps.guided_admin_setup_qa_salon_id = p_salon_id;
  RETURN pg_catalog.jsonb_build_object(
    'success', true, 'code', 'disabled', 'salon_id', p_salon_id
  );
END;
$configure_guided_setup_qa_salon$;

REVOKE ALL ON FUNCTION public.configure_guided_admin_setup_qa_salon(uuid, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.configure_guided_admin_setup_qa_salon(uuid, boolean, text)
  TO service_role;

COMMENT ON FUNCTION public.configure_guided_admin_setup_qa_salon(uuid, boolean, text) IS
  'Atomically binds or clears the single disposable Guided Setup QA salon. Service role only; no generic feature editor or UI calls this function.';
