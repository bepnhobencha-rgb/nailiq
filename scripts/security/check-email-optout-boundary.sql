\set ON_ERROR_STOP on

DO $check$
DECLARE
  v_oid oid := to_regclass('public.client_email_optouts');
  v_policy_count integer;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'client_email_optouts is missing';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'RLS is disabled on client_email_optouts';
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
    RAISE EXCEPTION 'direct API grants remain on client_email_optouts';
  END IF;

  IF NOT has_table_privilege(
    'service_role', v_oid,
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) THEN
    RAISE EXCEPTION 'service_role access is incomplete on client_email_optouts';
  END IF;

  SELECT count(*) INTO v_policy_count
  FROM pg_policy
  WHERE polrelid = v_oid;

  IF v_policy_count <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_policy
    WHERE polrelid = v_oid
      AND polname = 'deny direct API access to email optouts'
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
    RAISE EXCEPTION 'explicit client_email_optouts deny policy mismatch';
  END IF;
END
$check$;
