-- TurnIQ controlled SHADOW activation boundary.
--
-- This migration creates no allowlist rows and changes no platform flag, salon
-- flag, rollout stage, booking, provider, payment, or notification state. A
-- service-role caller may activate only an explicitly allowlisted, unexpired
-- disposable salon that passes the complete data-readiness preflight. Rollback
-- preserves policies and receipts as immutable evidence.

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE public.turniq_shadow_pilot_allowlist (
  salon_id uuid PRIMARY KEY REFERENCES public.salons(id) ON DELETE CASCADE,
  expected_slug text NOT NULL CHECK (
    length(pg_catalog.btrim(expected_slug)) BETWEEN 3 AND 120
  ),
  expires_at timestamptz NOT NULL,
  authorized_by_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (
    length(pg_catalog.btrim(reason)) BETWEEN 8 AND 500
  ),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  CONSTRAINT turniq_shadow_pilot_allowlist_revocation_check CHECK (
    revoked_at IS NULL OR revoked_at >= created_at
  )
);

COMMENT ON TABLE public.turniq_shadow_pilot_allowlist IS
  'Service-only, explicit and expiring allowlist for disposable TurnIQ SHADOW pilots. Empty by default; a schema migration can never activate a salon.';

CREATE TABLE public.turniq_shadow_activation_receipts (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  command_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('activate', 'rollback')),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_role text NOT NULL CHECK (actor_role IN ('owner', 'admin')),
  reason text NOT NULL CHECK (
    length(pg_catalog.btrim(reason)) BETWEEN 8 AND 500
  ),
  request_fingerprint text NOT NULL CHECK (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  policy_version_id uuid,
  before_state jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(before_state) = 'object'),
  after_state jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(after_state) = 'object'),
  readiness_snapshot jsonb NOT NULL CHECK (
    pg_catalog.jsonb_typeof(readiness_snapshot) = 'object'
  ),
  result jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(result) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  UNIQUE (salon_id, command_id),
  CONSTRAINT turniq_shadow_activation_receipt_policy_fk
    FOREIGN KEY (salon_id, policy_version_id)
    REFERENCES public.turniq_policy_versions(salon_id, id) ON DELETE RESTRICT
);

CREATE INDEX turniq_shadow_activation_receipts_history_idx
  ON public.turniq_shadow_activation_receipts
    (salon_id, occurred_at DESC, id DESC);

COMMENT ON TABLE public.turniq_shadow_activation_receipts IS
  'Immutable idempotent receipt for controlled TurnIQ SHADOW activation and rollback, including the readiness facts used for the decision.';

ALTER TABLE public.turniq_shadow_pilot_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_shadow_pilot_allowlist FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_shadow_activation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_shadow_activation_receipts FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.turniq_shadow_pilot_allowlist
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.turniq_shadow_activation_receipts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.turniq_shadow_pilot_allowlist
  TO service_role;
GRANT SELECT, INSERT ON TABLE public.turniq_shadow_activation_receipts
  TO service_role;

CREATE POLICY turniq_shadow_pilot_allowlist_deny_browser_access
  ON public.turniq_shadow_pilot_allowlist AS RESTRICTIVE FOR ALL
  TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY turniq_shadow_activation_receipts_deny_browser_access
  ON public.turniq_shadow_activation_receipts AS RESTRICTIVE FOR ALL
  TO anon, authenticated USING (false) WITH CHECK (false);

CREATE TRIGGER reject_turniq_shadow_activation_receipt_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_shadow_activation_receipts
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_immutable_mutation();

CREATE OR REPLACE FUNCTION public.configure_turniq_controlled_shadow_pilot_v1(
  p_salon_id uuid,
  p_action text,
  p_command_id uuid,
  p_actor_user_id uuid,
  p_actor_role text,
  p_reason text,
  p_request_fingerprint text,
  p_confirmation text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''
  );
  v_salon record;
  v_allowlist public.turniq_shadow_pilot_allowlist%ROWTYPE;
  v_allowlist_found boolean := false;
  v_existing_result jsonb;
  v_existing_fingerprint text;
  v_active_staff_count integer := 0;
  v_active_service_count integer := 0;
  v_unqualified_staff_count integer := 0;
  v_uncovered_service_count integer := 0;
  v_unscheduled_staff_count integer := 0;
  v_active_resource_count integer := 0;
  v_missing_resource_kind_count integer := 0;
  v_other_non_off_pilot_count integer := 0;
  v_current_stage text := 'off';
  v_before_platform_enabled boolean := false;
  v_before_platform_exists boolean := false;
  v_before_salon_enabled boolean := false;
  v_before_state jsonb;
  v_after_state jsonb;
  v_readiness jsonb;
  v_policy_id uuid;
  v_policy_version integer;
  v_effective_business_date date;
  v_stage_command_id uuid := extensions.gen_random_uuid();
  v_stage_result jsonb;
  v_result jsonb;
  v_prior_activation_platform_enabled boolean := true;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'unauthorized');
  END IF;

  IF p_salon_id IS NULL OR p_command_id IS NULL OR p_actor_user_id IS NULL
     OR p_action NOT IN ('activate', 'rollback')
     OR p_actor_role NOT IN ('owner', 'admin')
     OR length(pg_catalog.btrim(coalesce(p_reason, ''))) NOT BETWEEN 8 AND 500
     OR coalesce(p_request_fingerprint, '') !~ '^[0-9a-f]{64}$'
     OR p_confirmation IS DISTINCT FROM (CASE p_action
       WHEN 'activate' THEN 'ACTIVATE_TURNIQ_SHADOW_PILOT'
       WHEN 'rollback' THEN 'ROLLBACK_TURNIQ_SHADOW_PILOT'
     END) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'code', 'confirmation_required'
    );
  END IF;

  SELECT r.result, r.request_fingerprint
  INTO v_existing_result, v_existing_fingerprint
  FROM public.turniq_shadow_activation_receipts AS r
  WHERE r.salon_id = p_salon_id AND r.command_id = p_command_id;
  IF FOUND THEN
    IF v_existing_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'code', 'idempotency_conflict'
      );
    END IF;
    RETURN v_existing_result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  SELECT
    s.id, s.slug, s.timezone, s.vertical, s.subscription_status,
    s.archived_at, s.resources_enabled, s.feature_flags
  INTO v_salon
  FROM public.salons AS s
  WHERE s.id = p_salon_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.salon_members AS m
    WHERE m.salon_id = p_salon_id
      AND m.user_id = p_actor_user_id
      AND m.role = p_actor_role
      AND m.role IN ('owner', 'admin')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;

  SELECT a.* INTO v_allowlist
  FROM public.turniq_shadow_pilot_allowlist AS a
  WHERE a.salon_id = p_salon_id
  FOR UPDATE;
  v_allowlist_found := FOUND;
  IF p_action = 'activate' AND (
     NOT v_allowlist_found
     OR v_allowlist.expected_slug IS DISTINCT FROM v_salon.slug
     OR v_allowlist.revoked_at IS NOT NULL
     OR v_allowlist.expires_at <= pg_catalog.transaction_timestamp()
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', false, 'code', 'pilot_not_allowlisted'
    );
  END IF;

  SELECT c.stage INTO v_current_stage
  FROM public.turniq_rollout_controls AS c
  WHERE c.salon_id = p_salon_id;
  v_current_stage := coalesce(v_current_stage, 'off');

  SELECT f.enabled INTO v_before_platform_enabled
  FROM public.platform_flags AS f
  WHERE f.key = 'feature_turniq_trust_engine';
  v_before_platform_exists := FOUND;
  v_before_platform_enabled := coalesce(v_before_platform_enabled, false);
  v_before_salon_enabled := coalesce(
    v_salon.feature_flags -> 'turniq_trust_engine_enabled',
    'false'::jsonb
  ) = 'true'::jsonb;
  v_before_state := pg_catalog.jsonb_build_object(
    'platform_row_exists', v_before_platform_exists,
    'platform_enabled', v_before_platform_enabled,
    'salon_enabled', v_before_salon_enabled,
    'rollout_stage', v_current_stage
  );

  SELECT pg_catalog.count(*)::integer INTO v_active_staff_count
  FROM public.staff AS st
  WHERE st.salon_id = p_salon_id
    AND st.status = 'active' AND st.deleted_at IS NULL;
  SELECT pg_catalog.count(*)::integer INTO v_active_service_count
  FROM public.services AS sv
  WHERE sv.salon_id = p_salon_id AND sv.deleted_at IS NULL;
  SELECT pg_catalog.count(*)::integer INTO v_unqualified_staff_count
  FROM public.staff AS st
  WHERE st.salon_id = p_salon_id
    AND st.status = 'active' AND st.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.staff_services AS ss
      JOIN public.services AS sv ON sv.id = ss.service_id
      WHERE ss.staff_id = st.id AND sv.salon_id = p_salon_id
        AND sv.deleted_at IS NULL
    );
  SELECT pg_catalog.count(*)::integer INTO v_uncovered_service_count
  FROM public.services AS sv
  WHERE sv.salon_id = p_salon_id AND sv.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.staff_services AS ss
      JOIN public.staff AS st ON st.id = ss.staff_id
      WHERE ss.service_id = sv.id AND st.salon_id = p_salon_id
        AND st.status = 'active' AND st.deleted_at IS NULL
    );
  SELECT pg_catalog.count(*)::integer INTO v_unscheduled_staff_count
  FROM public.staff AS st
  WHERE st.salon_id = p_salon_id
    AND st.status = 'active' AND st.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.staff_shifts AS sh
      WHERE sh.staff_id = st.id AND sh.salon_id = p_salon_id
        AND sh.is_active IS TRUE
    );
  SELECT pg_catalog.count(*)::integer INTO v_active_resource_count
  FROM public.salon_resources AS sr
  WHERE sr.salon_id = p_salon_id
    AND sr.status = 'active' AND sr.deleted_at IS NULL;
  SELECT pg_catalog.count(*)::integer INTO v_missing_resource_kind_count
  FROM (
    SELECT DISTINCT pg_catalog.unnest(sv.required_resource_kinds) AS kind
    FROM public.services AS sv
    WHERE sv.salon_id = p_salon_id AND sv.deleted_at IS NULL
      AND sv.resource_requirement_mode = 'specific'
  ) AS required
  WHERE NOT EXISTS (
    SELECT 1 FROM public.salon_resources AS sr
    WHERE sr.salon_id = p_salon_id AND sr.kind = required.kind
      AND sr.status = 'active' AND sr.deleted_at IS NULL
  );
  SELECT pg_catalog.count(*)::integer INTO v_other_non_off_pilot_count
  FROM public.turniq_rollout_controls AS c
  WHERE c.salon_id <> p_salon_id AND c.stage <> 'off';

  v_readiness := pg_catalog.jsonb_build_object(
    'salon_active', v_salon.archived_at IS NULL
      AND v_salon.subscription_status IN ('active', 'trialing'),
    'nail_salon', v_salon.vertical = 'nail_salon',
    'active_staff_count', v_active_staff_count,
    'active_service_count', v_active_service_count,
    'unqualified_staff_count', v_unqualified_staff_count,
    'uncovered_service_count', v_uncovered_service_count,
    'unscheduled_staff_count', v_unscheduled_staff_count,
    'resources_enabled', v_salon.resources_enabled,
    'active_resource_count', v_active_resource_count,
    'missing_resource_kind_count', v_missing_resource_kind_count,
    'other_non_off_pilot_count', v_other_non_off_pilot_count,
    'allowlist_expires_at', CASE WHEN v_allowlist_found
      THEN v_allowlist.expires_at ELSE NULL END
  );

  IF p_action = 'activate' THEN
    IF v_current_stage <> 'off' THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'code', 'pilot_already_active',
        'stage', v_current_stage
      );
    END IF;
    IF v_salon.archived_at IS NOT NULL
       OR v_salon.subscription_status NOT IN ('active', 'trialing')
       OR v_salon.vertical <> 'nail_salon'
       OR v_active_staff_count < 3
       OR v_active_service_count < 1
       OR v_unqualified_staff_count > 0
       OR v_uncovered_service_count > 0
       OR v_unscheduled_staff_count > 0
       OR (v_salon.resources_enabled AND v_active_resource_count < 1)
       OR v_missing_resource_kind_count > 0
       OR v_other_non_off_pilot_count > 0 THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'code', 'readiness_failed',
        'readiness', v_readiness
      );
    END IF;

    SELECT coalesce(pg_catalog.max(p.version), 0) + 1
    INTO v_policy_version
    FROM public.turniq_policy_versions AS p
    WHERE p.salon_id = p_salon_id;
    v_effective_business_date :=
      (pg_catalog.transaction_timestamp() AT TIME ZONE v_salon.timezone)::date + 1;

    INSERT INTO public.turniq_policy_versions (
      salon_id, version, policy_name, business_timezone,
      effective_business_date, fairness_band_cents, ranking_strategy,
      opportunity_credit_basis, late_arrival_baseline_strategy,
      requested_technician_precedence, redo_turn_policy,
      redo_credit_policy, refusal_policy, emergency_same_day,
      policy_snapshot, created_by_user_id
    ) VALUES (
      p_salon_id, v_policy_version, 'Controlled SHADOW pilot', v_salon.timezone,
      v_effective_business_date, 2000, 'money_balanced_rotation_v1',
      'catalog_list_plus_permitted_addons_before_tax_tip',
      'median_eligible_team_credit_at_checkin', true, 'owner_review',
      'owner_review', 'move_to_end_unless_approved', false,
      pg_catalog.jsonb_build_object(
        'activation_mode', 'controlled_shadow',
        'activation_command_id', p_command_id,
        'readiness', v_readiness
      ),
      p_actor_user_id
    ) RETURNING id INTO v_policy_id;

    INSERT INTO public.platform_flags (
      key, enabled, description, updated_at, updated_by
    ) VALUES (
      'feature_turniq_trust_engine', true,
      'TurnIQ global operational gate; salon rollout remains separately controlled.',
      pg_catalog.transaction_timestamp(), p_actor_user_id
    ) ON CONFLICT (key) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      description = EXCLUDED.description,
      updated_at = EXCLUDED.updated_at,
      updated_by = EXCLUDED.updated_by;

    UPDATE public.salons
    SET feature_flags = pg_catalog.jsonb_set(
      feature_flags, '{turniq_trust_engine_enabled}', 'true'::jsonb, true
    )
    WHERE id = p_salon_id;

    SELECT public.configure_turniq_rollout_stage_v1(
      p_salon_id, 'shadow', v_stage_command_id, p_actor_user_id,
      p_actor_role, p_reason, p_request_fingerprint,
      'SET_TURNIQ_STAGE_SHADOW'
    ) INTO v_stage_result;
    IF coalesce((v_stage_result ->> 'ok')::boolean, false) IS NOT TRUE
       OR v_stage_result ->> 'stage' <> 'shadow' THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001',
        MESSAGE = 'TurnIQ SHADOW stage transition failed';
    END IF;

    v_after_state := pg_catalog.jsonb_build_object(
      'platform_enabled', true,
      'salon_enabled', true,
      'rollout_stage', 'shadow'
    );
    v_result := pg_catalog.jsonb_build_object(
      'ok', true, 'code', 'shadow_activated', 'salon_id', p_salon_id,
      'stage', 'shadow', 'policy_version_id', v_policy_id,
      'policy_effective_business_date', v_effective_business_date,
      'stage_command_id', v_stage_command_id, 'readiness', v_readiness,
      'replayed', false
    );
  ELSE
    IF v_current_stage NOT IN ('off', 'shadow') THEN
      RETURN pg_catalog.jsonb_build_object(
        'ok', false, 'code', 'rollback_requires_shadow_or_off',
        'stage', v_current_stage
      );
    END IF;

    IF v_current_stage = 'shadow' THEN
      SELECT public.configure_turniq_rollout_stage_v1(
        p_salon_id, 'off', v_stage_command_id, p_actor_user_id,
        p_actor_role, p_reason, p_request_fingerprint,
        'SET_TURNIQ_STAGE_OFF'
      ) INTO v_stage_result;
      IF coalesce((v_stage_result ->> 'ok')::boolean, false) IS NOT TRUE
         OR v_stage_result ->> 'stage' <> 'off' THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001',
          MESSAGE = 'TurnIQ OFF rollback transition failed';
      END IF;
    ELSE
      v_stage_result := pg_catalog.jsonb_build_object(
        'ok', true, 'code', 'unchanged', 'stage', 'off', 'replayed', true
      );
    END IF;

    UPDATE public.salons
    SET feature_flags = pg_catalog.jsonb_set(
      feature_flags, '{turniq_trust_engine_enabled}', 'false'::jsonb, true
    )
    WHERE id = p_salon_id;

    SELECT coalesce((r.before_state ->> 'platform_enabled')::boolean, true)
    INTO v_prior_activation_platform_enabled
    FROM public.turniq_shadow_activation_receipts AS r
    WHERE r.salon_id = p_salon_id AND r.action = 'activate'
    ORDER BY r.occurred_at DESC, r.id DESC
    LIMIT 1;
    v_prior_activation_platform_enabled :=
      coalesce(v_prior_activation_platform_enabled, true);

    SELECT pg_catalog.count(*)::integer INTO v_other_non_off_pilot_count
    FROM public.turniq_rollout_controls AS c
    WHERE c.salon_id <> p_salon_id AND c.stage <> 'off';
    IF v_other_non_off_pilot_count = 0
       AND v_prior_activation_platform_enabled IS FALSE THEN
      UPDATE public.platform_flags
      SET enabled = false,
          updated_at = pg_catalog.transaction_timestamp(),
          updated_by = p_actor_user_id
      WHERE key = 'feature_turniq_trust_engine';
    END IF;

    SELECT f.enabled INTO v_before_platform_enabled
    FROM public.platform_flags AS f
    WHERE f.key = 'feature_turniq_trust_engine';
    v_after_state := pg_catalog.jsonb_build_object(
      'platform_enabled', coalesce(v_before_platform_enabled, false),
      'salon_enabled', false,
      'rollout_stage', 'off'
    );
    v_result := pg_catalog.jsonb_build_object(
      'ok', true, 'code', 'shadow_rolled_back', 'salon_id', p_salon_id,
      'stage', 'off', 'stage_command_id', v_stage_command_id,
      'readiness', v_readiness, 'replayed', false
    );
  END IF;

  INSERT INTO public.turniq_shadow_activation_receipts (
    salon_id, command_id, action, actor_user_id, actor_role, reason,
    request_fingerprint, policy_version_id, before_state, after_state,
    readiness_snapshot, result
  ) VALUES (
    p_salon_id, p_command_id, p_action, p_actor_user_id, p_actor_role,
    pg_catalog.btrim(p_reason), p_request_fingerprint, v_policy_id,
    v_before_state, v_after_state, v_readiness, v_result
  );

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.configure_turniq_controlled_shadow_pilot_v1(
  uuid, text, uuid, uuid, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.configure_turniq_controlled_shadow_pilot_v1(
  uuid, text, uuid, uuid, text, text, text, text
) TO service_role;

COMMENT ON FUNCTION public.configure_turniq_controlled_shadow_pilot_v1(
  uuid, text, uuid, uuid, text, text, text, text
) IS 'Service-role-only controlled TurnIQ SHADOW activation/rollback. Activation requires an exact unexpired allowlist row; fail-safe rollback remains available after allowlist expiry/revocation. Both require owner/admin attribution, exact confirmation and idempotent immutable receipt.';

COMMIT;

-- Rollback: invoke ROLLBACK_TURNIQ_SHADOW_PILOT for every active allowlisted
-- QA salon first. Preserve policy versions, rollout events and activation
-- receipts as trust evidence. The allowlist may be revoked or allowed to expire.
