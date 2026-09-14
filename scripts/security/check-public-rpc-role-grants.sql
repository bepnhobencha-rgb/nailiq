\set ON_ERROR_STOP on

DO $check$
DECLARE
  v_target record;
  v_oid regprocedure;
  v_public_execute boolean;
BEGIN
  FOR v_target IN
    SELECT *
    FROM (
      VALUES
        ('public.add_booking_addons(uuid,uuid[])', true, false, true),
        ('public.check_group_slots_available(jsonb)', true, false, true),
        ('public.create_public_booking(uuid,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,text,integer,text,uuid,integer,text,uuid)', true, false, true),
        ('public.create_public_capacity_rescue_request(uuid,uuid,text,uuid,uuid,date,text,integer,text,text,text,text,jsonb)', false, false, true),
        ('public.create_public_capacity_rescue_request_v2(uuid,uuid,text,uuid,uuid,date,text,integer,text,text,text,text,jsonb,text)', false, false, true),
        ('public.create_public_waitlist_entry(uuid,uuid,uuid,date,text,text,text,text,text)', false, false, true),
        ('public.evaluate_individual_waitlist_capacity(uuid,uuid,uuid,date,text)', false, false, true),
        ('public.get_booking_client_snapshot(uuid,text,uuid)', true, false, true),
        ('public.insert_group_bookings(jsonb)', false, false, true),
        ('public.public_booking_occupancy_for_range(uuid,timestamp with time zone,timestamp with time zone)', true, false, true),
        ('public.public_resolve_domain(text)', true, false, true),
        ('public.salon_has_staff_services(uuid)', false, true, true),
        ('public.validate_booking_otp_session(uuid,uuid,text)', true, false, true),
        ('public.validate_phone_otp_session(uuid,uuid,text)', true, false, true),
        ('public.booking_incentive_phone_ownership(uuid,uuid,text,boolean)', false, false, true),
        ('public.resolve_public_booking_pricing(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,uuid[],uuid,uuid,text,text,boolean,boolean,uuid)', false, false, true),
        ('public.quote_public_booking(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,uuid[],uuid,uuid,text,text,boolean,uuid)', false, false, true),
        ('public.resolve_group_booking_pricing(uuid,jsonb,uuid,text,text,boolean,boolean,uuid)', false, false, true),
        ('public.create_public_booking(uuid,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text,uuid)', true, false, true),
        ('public.quote_group_booking(uuid,jsonb,uuid,text,text,boolean,uuid)', false, false, true),
        ('public.create_group_bookings(uuid,jsonb,uuid,text,text,boolean,uuid,text,uuid)', false, false, true),
        ('public.resolve_public_deposit_payment_material(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,uuid[],uuid,uuid,text,text,boolean,uuid,text,uuid)', false, false, true),
        ('public.load_public_deposit_payment_material(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,uuid[],uuid,uuid,text,text,boolean,uuid,text,uuid)', false, false, true),
        ('public.claim_public_deposit_payment_operation(uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,uuid[],uuid,uuid,text,text,boolean,uuid,text,uuid,uuid)', false, false, true),
        ('public.create_public_booking_with_deposit_payment(uuid,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text,uuid,uuid,text,uuid)', false, false, true),
        ('public.attach_desk_booking_client_profiles(uuid,uuid[],uuid)', false, false, false),
        ('public.lock_booking_crm_phones(text[])', false, false, false),
        ('public.create_group_bookings_for_desk(uuid,jsonb,uuid,text,text,boolean,uuid,text,uuid)', false, false, true),
        ('public.claim_party_slot_for_desk(text,uuid,text,text,boolean,uuid,uuid)', false, false, true),
        ('public.update_party_booking_contact(uuid,uuid,text,text)', false, false, false),
        ('public.square_card_booking_phone_authorized(uuid,uuid,jsonb)', false, false, false),
        ('public.square_card_prior_attempts_terminal(uuid,uuid)', false, false, false),
        ('public.bind_booking_existing_card_receipt(uuid,uuid,text,text,text)', false, false, false),
        ('public.pause_tenant_if_payment_grace_expired(uuid,timestamp with time zone)', false, false, true),
        ('public.replay_public_booking_with_deposit_payment(uuid,uuid,uuid,text,text,timestamp with time zone,timestamp with time zone,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text,uuid,uuid,text,uuid)', false, false, true)
    ) AS expected(signature, allow_anon, allow_authenticated, allow_service_role)
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

    IF has_function_privilege('service_role', v_oid, 'EXECUTE')
       IS DISTINCT FROM v_target.allow_service_role THEN
      RAISE EXCEPTION 'service_role grant mismatch on %', v_target.signature;
    END IF;
  END LOOP;
END
$check$;
