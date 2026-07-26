\set ON_ERROR_STOP on

-- Rehearse the exact emergency rollback, prove the former direct-call
-- capability is restored, then discard it so the hardened grants remain.
BEGIN;

GRANT EXECUTE ON FUNCTION public.cancel_booking_as_customer(uuid)
  TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_party_slot(text, uuid, text, text, boolean)
  TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_waitlist_slot(uuid)
  TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_booking_as_customer(uuid)
  TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_party_member(uuid, text)
  TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decline_party_member(uuid, text, text, text)
  TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_booking_as_customer(
  uuid,
  timestamp with time zone,
  timestamp with time zone
) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_party_claim_details(
  text,
  uuid,
  text,
  text,
  boolean
) TO PUBLIC, anon, authenticated;

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

    IF NOT has_function_privilege('anon', v_oid, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'rollback did not restore direct execute on %', v_signature;
    END IF;
  END LOOP;
END
$proof$;

ROLLBACK;

\ir check-server-only-customer-rpc-grants.sql
