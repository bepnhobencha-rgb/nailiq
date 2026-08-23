-- Forward-only correction: the sequence-aware RPC has search_path='', so a
-- named deferred constraint trigger cannot be resolved by SET CONSTRAINTS.
-- Match the canonical sequence-reschedule contract and force all deferred
-- checks at the atomic boundary instead.
DO $repair_constraint_boundary$
DECLARE
  v_definition text;
  v_repaired text;
  v_immediate text:='SET CONSTRAINTS check_booking_service_sequence_shape IMMEDIATE;';
  v_deferred text:='SET CONSTRAINTS check_booking_service_sequence_shape DEFERRED;';
BEGIN
  SELECT pg_catalog.pg_get_functiondef(
    'public.offboard_staff_with_durable_notifications(uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer)'::regprocedure
  ) INTO STRICT v_definition;
  IF pg_catalog.strpos(v_definition,v_immediate)=0
     OR pg_catalog.strpos(v_definition,v_deferred)=0 THEN
    RAISE EXCEPTION 'unexpected staff-offboarding constraint boundary; refusing repair';
  END IF;
  v_repaired:=pg_catalog.replace(v_definition,v_immediate,'SET CONSTRAINTS ALL IMMEDIATE;');
  v_repaired:=pg_catalog.replace(v_repaired,v_deferred,'SET CONSTRAINTS ALL DEFERRED;');
  EXECUTE v_repaired;
END;
$repair_constraint_boundary$;

REVOKE ALL ON FUNCTION public.offboard_staff_with_durable_notifications(
  uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer
) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.offboard_staff_with_durable_notifications(
  uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer
) TO service_role;
