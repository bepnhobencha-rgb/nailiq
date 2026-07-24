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
          'client_ai_summaries',
          'deny direct API access to client ai summaries'
        ),
        (
          'salon_clients',
          'deny direct API access to salon clients'
        ),
        (
          'salon_client_names',
          'deny direct API access to salon client names'
        ),
        (
          'salon_client_spend',
          'deny direct API access to salon client spend'
        )
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
      RAISE EXCEPTION 'client-intelligence table is missing: %',
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
