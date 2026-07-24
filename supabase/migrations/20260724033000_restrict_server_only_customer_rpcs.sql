-- These customer-action RPCs are reached only through NailIQ server
-- routes/actions that use the service-role client. Leaving PostgreSQL's
-- default PUBLIC execute grant in place also made them callable directly
-- through PostgREST by anon and authenticated users, bypassing the server
-- boundary that performs preview, notification, audit, and fee handling.

REVOKE ALL ON FUNCTION public.cancel_booking_as_customer(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_party_slot(text, uuid, text, text, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_waitlist_slot(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_booking_as_customer(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_party_member(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.decline_party_member(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reschedule_booking_as_customer(
  uuid,
  timestamp with time zone,
  timestamp with time zone
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_party_claim_details(
  text,
  uuid,
  text,
  text,
  boolean
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.cancel_booking_as_customer(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_party_slot(text, uuid, text, text, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_waitlist_slot(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_booking_as_customer(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_party_member(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.decline_party_member(uuid, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reschedule_booking_as_customer(
  uuid,
  timestamp with time zone,
  timestamp with time zone
) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_party_claim_details(
  text,
  uuid,
  text,
  text,
  boolean
) TO service_role;

DO $proof$
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
      RAISE EXCEPTION 'untrusted role can still execute %', v_signature;
    END IF;

    IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot execute %', v_signature;
    END IF;
  END LOOP;
END
$proof$;
