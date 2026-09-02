-- Refuse reuse of a rollout command ID with different material. Patch the QA
-- definition with exact drift checks; a fresh database already receives this
-- behavior from the authoritative create migration.

DO $patch$
DECLARE
  v_definition text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.configure_turniq_rollout_stage_v1(uuid,text,uuid,uuid,text,text,text,text)'::regprocedure
  ) INTO v_definition;

  v_old := $old_decl$  v_existing jsonb;
  v_result jsonb;$old_decl$;
  v_new := $new_decl$  v_existing jsonb;
  v_existing_fingerprint text;
  v_result jsonb;$new_decl$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    IF pg_catalog.strpos(v_definition, v_new) = 0 THEN
      RAISE EXCEPTION 'TurnIQ rollout idempotency declaration drifted';
    END IF;
  ELSE
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  END IF;

  v_old := $old_replay$  SELECT e.result INTO v_existing
  FROM public.turniq_rollout_events e
  WHERE e.salon_id = p_salon_id AND e.command_id = p_command_id;
  IF FOUND THEN RETURN v_existing || pg_catalog.jsonb_build_object('replayed', true); END IF;$old_replay$;
  v_new := $new_replay$  SELECT e.result, e.request_fingerprint
  INTO v_existing, v_existing_fingerprint
  FROM public.turniq_rollout_events e
  WHERE e.salon_id = p_salon_id AND e.command_id = p_command_id;
  IF FOUND THEN
    IF v_existing_fingerprint IS DISTINCT FROM p_request_fingerprint THEN
      RETURN pg_catalog.jsonb_build_object('ok', false, 'code', 'idempotency_conflict');
    END IF;
    RETURN v_existing || pg_catalog.jsonb_build_object('replayed', true);
  END IF;$new_replay$;
  IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
    IF pg_catalog.strpos(v_definition, v_new) = 0 THEN
      RAISE EXCEPTION 'TurnIQ rollout idempotency replay guard drifted';
    END IF;
  ELSE
    v_definition := pg_catalog.replace(v_definition, v_old, v_new);
  END IF;

  EXECUTE v_definition;
END;
$patch$;

-- Rollback: keep the stricter replay guard. It changes no stage or salon flag.
