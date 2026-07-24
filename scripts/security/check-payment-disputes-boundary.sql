\set ON_ERROR_STOP on

DO $check$
DECLARE
  v_oid oid := to_regclass('public.payment_disputes');
  v_policy_count integer;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'payment_disputes is missing';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'RLS is disabled on payment_disputes';
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
    RAISE EXCEPTION 'direct API grants remain on payment_disputes';
  END IF;

  IF NOT has_table_privilege(
    'service_role', v_oid,
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) THEN
    RAISE EXCEPTION 'service_role access is incomplete on payment_disputes';
  END IF;

  SELECT count(*) INTO v_policy_count
  FROM pg_policy
  WHERE polrelid = v_oid;

  IF v_policy_count <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_policy
    WHERE polrelid = v_oid
      AND polname = 'deny direct API access to payment disputes'
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
    RAISE EXCEPTION 'explicit payment_disputes deny policy mismatch';
  END IF;
END
$check$;
