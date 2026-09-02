-- Schema-parity hotfix for the disposable QA apply: make the control-row
-- material check strictly non-null and make transition history append-only at
-- the database boundary. This changes no rollout stage or salon flag.

ALTER TABLE public.turniq_rollout_controls
  DROP CONSTRAINT turniq_rollout_controls_change_material_check;
ALTER TABLE public.turniq_rollout_controls
  ADD CONSTRAINT turniq_rollout_controls_change_material_check CHECK (
    (state_version = 0 AND stage = 'off' AND changed_by_user_id IS NULL AND reason IS NULL)
    OR
    (state_version > 0 AND changed_by_user_id IS NOT NULL AND reason IS NOT NULL
      AND length(pg_catalog.btrim(reason)) BETWEEN 8 AND 500)
  );

CREATE OR REPLACE FUNCTION public.reject_turniq_rollout_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '42501',
    MESSAGE = 'TurnIQ rollout events are append-only';
END;
$function$;

REVOKE ALL ON FUNCTION public.reject_turniq_rollout_event_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS reject_turniq_rollout_event_mutation
  ON public.turniq_rollout_events;
CREATE TRIGGER reject_turniq_rollout_event_mutation
  BEFORE UPDATE OR DELETE ON public.turniq_rollout_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_turniq_rollout_event_mutation();

-- Rollback: keep the trigger and evidence. If application rollback requires
-- it, move the salon to OFF through configure_turniq_rollout_stage_v1.
