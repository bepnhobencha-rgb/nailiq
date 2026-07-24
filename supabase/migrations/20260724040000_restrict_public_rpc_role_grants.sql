-- Keep each public booking helper executable only by the role(s) used by its
-- audited application call sites. PostgreSQL grants EXECUTE to PUBLIC by
-- default, which also makes a function executable by every present and future
-- login role. These SECURITY DEFINER RPCs need explicit, least-privilege ACLs.

REVOKE ALL ON FUNCTION public.add_booking_addons(uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_group_slots_available(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_public_booking(
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
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_public_waitlist_entry(
  uuid,
  uuid,
  uuid,
  date,
  text,
  text,
  text,
  text,
  text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_booking_client_snapshot(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.insert_group_bookings(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.public_booking_occupancy_for_range(
  uuid,
  timestamp with time zone,
  timestamp with time zone
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.public_resolve_domain(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.salon_has_staff_services(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_phone_otp_session(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;

-- Stateless public booking surfaces deliberately use the anon credential.
GRANT EXECUTE ON FUNCTION public.add_booking_addons(uuid, uuid[])
  TO anon;
GRANT EXECUTE ON FUNCTION public.check_group_slots_available(jsonb)
  TO anon;
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
) TO anon;
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
) TO anon;
GRANT EXECUTE ON FUNCTION public.get_booking_client_snapshot(uuid, text, uuid)
  TO anon;
GRANT EXECUTE ON FUNCTION public.insert_group_bookings(jsonb)
  TO anon;
GRANT EXECUTE ON FUNCTION public.public_booking_occupancy_for_range(
  uuid,
  timestamp with time zone,
  timestamp with time zone
) TO anon;
GRANT EXECUTE ON FUNCTION public.public_resolve_domain(text)
  TO anon;
GRANT EXECUTE ON FUNCTION public.validate_phone_otp_session(uuid, uuid, text)
  TO anon;

-- This availability probe is also called while a dashboard session exists.
GRANT EXECUTE ON FUNCTION public.check_group_slots_available(jsonb)
  TO authenticated;

-- Dashboard setup/receptionist actions use the caller-scoped authenticated
-- client; public booking code does not call this capability helper.
GRANT EXECUTE ON FUNCTION public.salon_has_staff_services(uuid)
  TO authenticated;

-- Voice, receptionist and API routes use the service-role client.
GRANT EXECUTE ON FUNCTION public.add_booking_addons(uuid, uuid[])
  TO service_role;
GRANT EXECUTE ON FUNCTION public.check_group_slots_available(jsonb)
  TO service_role;
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
) TO service_role;
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
) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_booking_client_snapshot(uuid, text, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.insert_group_bookings(jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.public_booking_occupancy_for_range(
  uuid,
  timestamp with time zone,
  timestamp with time zone
) TO service_role;
GRANT EXECUTE ON FUNCTION public.public_resolve_domain(text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.salon_has_staff_services(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.validate_phone_otp_session(uuid, uuid, text)
  TO service_role;

DO $proof$
DECLARE
  v_target record;
  v_oid regprocedure;
  v_public_execute boolean;
BEGIN
  FOR v_target IN
    SELECT *
    FROM (
      VALUES
        ('public.add_booking_addons(uuid,uuid[])', true, false),
        ('public.check_group_slots_available(jsonb)', true, true),
        ('public.create_public_booking(uuid,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,text,integer,text,uuid,integer,text,uuid)', true, false),
        ('public.create_public_waitlist_entry(uuid,uuid,uuid,date,text,text,text,text,text)', true, false),
        ('public.get_booking_client_snapshot(uuid,text,uuid)', true, false),
        ('public.insert_group_bookings(jsonb)', true, false),
        ('public.public_booking_occupancy_for_range(uuid,timestamp with time zone,timestamp with time zone)', true, false),
        ('public.public_resolve_domain(text)', true, false),
        ('public.salon_has_staff_services(uuid)', false, true),
        ('public.validate_phone_otp_session(uuid,uuid,text)', true, false)
    ) AS expected(signature, allow_anon, allow_authenticated)
  LOOP
    v_oid := to_regprocedure(v_target.signature);

    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'public RPC is missing: %', v_target.signature;
    END IF;

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

    IF v_public_execute THEN
      RAISE EXCEPTION 'PUBLIC can execute %', v_target.signature;
    END IF;

    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       IS DISTINCT FROM v_target.allow_anon THEN
      RAISE EXCEPTION 'anon grant mismatch on %', v_target.signature;
    END IF;

    IF has_function_privilege('authenticated', v_oid, 'EXECUTE')
       IS DISTINCT FROM v_target.allow_authenticated THEN
      RAISE EXCEPTION 'authenticated grant mismatch on %', v_target.signature;
    END IF;

    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot execute %', v_target.signature;
    END IF;
  END LOOP;
END
$proof$;
