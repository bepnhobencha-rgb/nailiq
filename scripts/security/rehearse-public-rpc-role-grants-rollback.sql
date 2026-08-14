\set ON_ERROR_STOP on

-- Restore the exact pre-migration ACL shape inside a transaction, prove it,
-- then roll it back so the least-privilege grants remain active.
BEGIN;

GRANT EXECUTE ON FUNCTION public.add_booking_addons(uuid, uuid[])
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_group_slots_available(jsonb)
  TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_booking(
  uuid,
  uuid,
  uuid,
  text,
  text,
  timestamp with time zone,
  timestamp with time zone,
  text,
  integer,
  text,
  uuid,
  integer,
  text,
  uuid
) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_waitlist_entry(
  uuid,
  uuid,
  uuid,
  date,
  text,
  text,
  text,
  text,
  text
) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_booking_client_snapshot(uuid, text, uuid)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_group_bookings(jsonb, uuid)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_booking_occupancy_for_range(
  uuid,
  timestamp with time zone,
  timestamp with time zone
) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_resolve_domain(text)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.salon_has_staff_services(uuid)
  TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_phone_otp_session(uuid, uuid, text)
  TO anon, authenticated;

DO $rollback_proof$
DECLARE
  v_target record;
  v_oid regprocedure;
  v_public_execute boolean;
BEGIN
  FOR v_target IN
    SELECT *
    FROM (
      VALUES
        ('public.add_booking_addons(uuid,uuid[])', false),
        ('public.check_group_slots_available(jsonb)', true),
        ('public.create_public_booking(uuid,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,text,integer,text,uuid,integer,text,uuid)', false),
        ('public.create_public_waitlist_entry(uuid,uuid,uuid,date,text,text,text,text,text)', true),
        ('public.get_booking_client_snapshot(uuid,text,uuid)', false),
        ('public.insert_group_bookings(jsonb,uuid)', false),
        ('public.public_booking_occupancy_for_range(uuid,timestamp with time zone,timestamp with time zone)', true),
        ('public.public_resolve_domain(text)', false),
        ('public.salon_has_staff_services(uuid)', true),
        ('public.validate_phone_otp_session(uuid,uuid,text)', false)
    ) AS previous(signature, allow_public)
  LOOP
    v_oid := to_regprocedure(v_target.signature);

    SELECT EXISTS (
      SELECT 1
      FROM aclexplode(
        COALESCE(
          (SELECT proacl FROM pg_proc WHERE oid = v_oid),
          acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = v_oid))
        )
      )
      WHERE grantee = 0
        AND privilege_type = 'EXECUTE'
    ) INTO v_public_execute;

    IF v_public_execute IS DISTINCT FROM v_target.allow_public THEN
      RAISE EXCEPTION 'rollback PUBLIC grant mismatch on %', v_target.signature;
    END IF;

    IF NOT has_function_privilege('anon', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'rollback did not restore prior role grants on %',
        v_target.signature;
    END IF;
  END LOOP;
END
$rollback_proof$;

ROLLBACK;

\ir check-public-rpc-role-grants.sql
