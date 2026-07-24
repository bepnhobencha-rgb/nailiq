\set ON_ERROR_STOP on

DO $check$
DECLARE
  v_signature text;
  v_oid regprocedure;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.cancel_booking_as_customer(uuid)',
    'public.claim_party_slot(text,uuid,text,text,boolean)',
    'public.claim_waitlist_slot(uuid)',
    'public.confirm_booking_as_customer(uuid)',
    'public.confirm_party_member(uuid,text)',
    'public.decline_party_member(uuid,text,text,text)',
    'public.reschedule_booking_as_customer(uuid,timestamp with time zone,timestamp with time zone)',
    'public.update_party_claim_details(text,uuid,text,text,boolean)'
  ]
  LOOP
    v_oid := to_regprocedure(v_signature);

    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'server-only RPC is missing: %', v_signature;
    END IF;

    IF has_function_privilege('anon', v_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'untrusted role can execute %', v_signature;
    END IF;

    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot execute %', v_signature;
    END IF;
  END LOOP;
END
$check$;
