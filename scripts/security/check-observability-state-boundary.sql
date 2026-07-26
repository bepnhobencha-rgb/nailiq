\set ON_ERROR_STOP on

DO $check$
DECLARE
  v_target record;
  v_oid oid;
  v_policy_count integer;
BEGIN
  FOR v_target IN
    SELECT *
    FROM (
      VALUES
        (
          'ai_policy_decisions',
          'deny direct API access to AI policy decisions'
        ),
        ('system_audit', 'deny direct API access to system audit'),
        ('watchdog_alerts', 'deny direct API access to watchdog alerts'),
        ('watchdog_state', 'deny direct API access to watchdog state')
    ) AS expected(table_name, policy_name)
  LOOP
    SELECT c.oid
      INTO v_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = v_target.table_name
      AND c.relkind = 'r';

    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'observability-state table is missing: %',
        v_target.table_name;
    END IF;

    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_oid) THEN
      RAISE EXCEPTION 'RLS is disabled on %', v_target.table_name;
    END IF;

    IF has_table_privilege(
      'anon', v_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR has_table_privilege(
      'authenticated', v_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR has_any_column_privilege(
      'anon', v_oid, 'SELECT,INSERT,UPDATE,REFERENCES'
    ) OR has_any_column_privilege(
      'authenticated', v_oid, 'SELECT,INSERT,UPDATE,REFERENCES'
    ) THEN
      RAISE EXCEPTION 'direct API grants remain on %',
        v_target.table_name;
    END IF;

    IF NOT has_table_privilege(
      'service_role', v_oid,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) THEN
      RAISE EXCEPTION 'service_role access is incomplete on %',
        v_target.table_name;
    END IF;

    SELECT count(*)
      INTO v_policy_count
    FROM pg_policy
    WHERE polrelid = v_oid;

    IF v_policy_count <> 1 OR NOT EXISTS (
      SELECT 1
      FROM pg_policy
      WHERE polrelid = v_oid
        AND polname = v_target.policy_name
        AND NOT polpermissive
        AND polcmd = '*'
        AND cardinality(polroles) = 2
        AND polroles @> ARRAY[
          (SELECT oid FROM pg_roles WHERE rolname = 'anon'),
          (SELECT oid FROM pg_roles WHERE rolname = 'authenticated')
        ]::oid[]
        AND pg_get_expr(polqual, polrelid) = 'false'
        AND pg_get_expr(polwithcheck, polrelid) = 'false'
    ) THEN
      RAISE EXCEPTION 'explicit deny policy mismatch on %',
        v_target.table_name;
    END IF;
  END LOOP;
END
$check$;

DO $audit_trigger_check$
DECLARE
  v_oid oid := 'public.log_system_audit()'::regprocedure::oid;
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
     OR pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = v_oid))
        <> 'postgres'
     OR has_function_privilege(
       'anon', 'public.log_system_audit()', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.log_system_audit()', 'EXECUTE'
     )
     OR NOT has_function_privilege(
       'service_role', 'public.log_system_audit()', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'system-audit trigger boundary mismatch';
  END IF;
END
$audit_trigger_check$;
