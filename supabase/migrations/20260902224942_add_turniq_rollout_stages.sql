-- TurnIQ rollout is a state machine, not a boolean. Missing rows resolve to OFF.
-- This migration creates no rows, changes no salon flag, and cannot enable a
-- production salon. Direct Data API writes are denied; transitions are
-- service-role-only, actor-attributed, idempotent and append-only audited.

CREATE TABLE public.turniq_rollout_controls (
  salon_id uuid PRIMARY KEY REFERENCES public.salons(id) ON DELETE CASCADE,
  stage text NOT NULL DEFAULT 'off'
    CHECK (stage IN ('off', 'shadow', 'supervised', 'live')),
  state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  changed_by_user_id uuid,
  changed_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  reason text,
  CONSTRAINT turniq_rollout_controls_change_material_check CHECK (
    (state_version = 0 AND stage = 'off' AND changed_by_user_id IS NULL AND reason IS NULL)
    OR
    (state_version > 0 AND changed_by_user_id IS NOT NULL AND reason IS NOT NULL
      AND length(pg_catalog.btrim(reason)) BETWEEN 8 AND 500)
  )
);

COMMENT ON TABLE public.turniq_rollout_controls IS
  'Private authoritative TurnIQ rollout stage. No row means OFF. SHADOW is read/recommend only, SUPERVISED permits confirmed online commands, and LIVE additionally permits primary-device offline commands.';

CREATE TABLE public.turniq_rollout_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  salon_id uuid NOT NULL REFERENCES public.salons(id) ON DELETE CASCADE,
  command_id uuid NOT NULL,
  from_stage text NOT NULL CHECK (from_stage IN ('off', 'shadow', 'supervised', 'live')),
  to_stage text NOT NULL CHECK (to_stage IN ('off', 'shadow', 'supervised', 'live')),
  state_version bigint NOT NULL CHECK (state_version > 0),
  actor_user_id uuid NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('owner', 'admin')),
  reason text NOT NULL CHECK (length(pg_catalog.btrim(reason)) BETWEEN 8 AND 500),
  occurred_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL,
  UNIQUE (salon_id, command_id),
  UNIQUE (salon_id, state_version)
);

CREATE INDEX turniq_rollout_events_history_idx
  ON public.turniq_rollout_events (salon_id, occurred_at DESC, id DESC);

COMMENT ON TABLE public.turniq_rollout_events IS
  'Append-only receipt for every TurnIQ rollout transition. Rollbacks add a new event and never rewrite history.';

ALTER TABLE public.turniq_rollout_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_rollout_controls FORCE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_rollout_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turniq_rollout_events FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.turniq_rollout_controls
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.turniq_rollout_events
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.turniq_rollout_controls TO service_role;
GRANT SELECT ON TABLE public.turniq_rollout_events TO service_role;

CREATE POLICY turniq_rollout_controls_deny_direct_access
  ON public.turniq_rollout_controls AS RESTRICTIVE FOR ALL
  TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY turniq_rollout_events_deny_direct_access
  ON public.turniq_rollout_events AS RESTRICTIVE FOR ALL
  TO anon, authenticated USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.configure_turniq_rollout_stage_v1(
  p_salon_id uuid,
  p_to_stage text,
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
  v_from_stage text := 'off';
  v_from_rank integer := 0;
  v_to_rank integer;
  v_state_version bigint := 0;
  v_existing jsonb;
  v_existing_fingerprint text;
  v_result jsonb;
BEGIN
  IF v_role <> 'service_role' THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'unauthorized');
  END IF;
  IF p_salon_id IS NULL OR p_command_id IS NULL OR p_actor_user_id IS NULL
     OR p_actor_role NOT IN ('owner', 'admin')
     OR p_to_stage NOT IN ('off', 'shadow', 'supervised', 'live')
     OR length(pg_catalog.btrim(coalesce(p_reason, ''))) NOT BETWEEN 8 AND 500
     OR coalesce(p_request_fingerprint, '') !~ '^[0-9a-f]{64}$'
     OR p_confirmation IS DISTINCT FROM
       ('SET_TURNIQ_STAGE_' || pg_catalog.upper(p_to_stage)) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'confirmation_required');
  END IF;

  SELECT e.result, e.request_fingerprint
  INTO v_existing, v_existing_fingerprint
  FROM public.turniq_rollout_events e
  WHERE e.salon_id = p_salon_id AND e.command_id = p_command_id;
  IF FOUND THEN
    IF v_existing_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
    END IF;
    RETURN v_existing || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  PERFORM 1 FROM public.salons s WHERE s.id = p_salon_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'not_found');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.salon_members m
    WHERE m.salon_id = p_salon_id AND m.user_id = p_actor_user_id
      AND m.role = p_actor_role AND m.role IN ('owner', 'admin')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;

  INSERT INTO public.turniq_rollout_controls (salon_id)
  VALUES (p_salon_id) ON CONFLICT (salon_id) DO NOTHING;
  SELECT c.stage, c.state_version INTO v_from_stage, v_state_version
  FROM public.turniq_rollout_controls c
  WHERE c.salon_id = p_salon_id FOR UPDATE;

  IF v_from_stage = p_to_stage THEN
    RETURN pg_catalog.jsonb_build_object(
      'ok', true, 'code', 'unchanged', 'salon_id', p_salon_id,
      'stage', v_from_stage, 'state_version', v_state_version, 'replayed', true
    );
  END IF;

  v_from_rank := CASE v_from_stage
    WHEN 'off' THEN 0 WHEN 'shadow' THEN 1 WHEN 'supervised' THEN 2 ELSE 3 END;
  v_to_rank := CASE p_to_stage
    WHEN 'off' THEN 0 WHEN 'shadow' THEN 1 WHEN 'supervised' THEN 2 ELSE 3 END;
  IF v_to_rank > v_from_rank + 1 THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'stage_skip_forbidden');
  END IF;

  IF p_to_stage <> 'off' AND NOT EXISTS (
    SELECT 1 FROM public.salons s
    WHERE s.id = p_salon_id AND s.archived_at IS NULL
      AND s.subscription_status IN ('active', 'trialing')
      AND coalesce(s.feature_flags -> 'turniq_trust_engine_enabled', 'false'::jsonb) = 'true'::jsonb
  ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'salon_not_ready');
  END IF;
  IF p_to_stage <> 'off' AND NOT EXISTS (
    SELECT 1 FROM public.platform_flags f
    WHERE f.key = 'feature_turniq_trust_engine' AND f.enabled IS TRUE
  ) THEN
    RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'platform_disabled');
  END IF;

  v_state_version := v_state_version + 1;
  UPDATE public.turniq_rollout_controls
  SET stage = p_to_stage,
      state_version = v_state_version,
      changed_by_user_id = p_actor_user_id,
      changed_at = pg_catalog.transaction_timestamp(),
      reason = pg_catalog.btrim(p_reason)
  WHERE salon_id = p_salon_id;

  v_result := pg_catalog.jsonb_build_object(
    'ok', true, 'code', 'stage_changed', 'salon_id', p_salon_id,
    'from_stage', v_from_stage, 'stage', p_to_stage,
    'state_version', v_state_version, 'replayed', false
  );
  INSERT INTO public.turniq_rollout_events (
    salon_id, command_id, from_stage, to_stage, state_version,
    actor_user_id, actor_role, reason, request_fingerprint, result
  ) VALUES (
    p_salon_id, p_command_id, v_from_stage, p_to_stage, v_state_version,
    p_actor_user_id, p_actor_role, pg_catalog.btrim(p_reason),
    p_request_fingerprint, v_result
  );
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.configure_turniq_rollout_stage_v1(
  uuid, text, uuid, uuid, text, text, text, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.configure_turniq_rollout_stage_v1(
  uuid, text, uuid, uuid, text, text, text, text
) TO service_role;

COMMENT ON FUNCTION public.configure_turniq_rollout_stage_v1(
  uuid, text, uuid, uuid, text, text, text, text
) IS 'Service-role-only, owner/admin-attributed TurnIQ stage transition. Forward transitions cannot skip a stage; rollback may move directly to a safer stage.';

-- Rollback: call the RPC with SET_TURNIQ_STAGE_OFF before rolling application
-- code back. Keep both tables as immutable operational evidence.
