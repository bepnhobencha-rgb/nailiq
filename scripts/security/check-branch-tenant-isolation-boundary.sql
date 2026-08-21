\set ON_ERROR_STOP on

DO $$
DECLARE v_table record;
BEGIN
  FOR v_table IN
    SELECT c.oid::regclass AS relation
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
  LOOP
    IF has_table_privilege('anon',v_table.relation,'TRUNCATE')
       OR has_table_privilege('authenticated',v_table.relation,'TRUNCATE')
       OR has_table_privilege('anon',v_table.relation,'TRIGGER')
       OR has_table_privilege('authenticated',v_table.relation,'TRIGGER')
       OR has_table_privilege('anon',v_table.relation,'REFERENCES')
       OR has_table_privilege('authenticated',v_table.relation,'REFERENCES') THEN
      RAISE EXCEPTION 'browser table-control privilege remains on %',v_table.relation;
    END IF;
  END LOOP;

  IF NOT EXISTS(
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='bookings'
      AND cmd='SELECT' AND 'authenticated'=ANY(roles)
      AND qual LIKE '%salon_members%auth.uid%'
  ) OR NOT EXISTS(
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='bookings'
      AND cmd='UPDATE' AND 'authenticated'=ANY(roles)
      AND qual LIKE '%salon_members%auth.uid%' AND with_check LIKE '%salon_members%auth.uid%'
  ) THEN
    RAISE EXCEPTION 'booking tenant RLS contract missing';
  END IF;

  IF has_function_privilege('anon','public.load_salon_member_operational_profile(uuid)','EXECUTE')
     OR has_function_privilege('service_role','public.load_salon_member_operational_profile(uuid)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.load_salon_member_operational_profile(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'member operational RPC grant boundary drifted';
  END IF;
  IF has_function_privilege('anon','public.create_public_booking_for_desk_with_staff_notification(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text,uuid,boolean,boolean,integer)','EXECUTE')
     OR has_function_privilege('authenticated','public.create_public_booking_for_desk_with_staff_notification(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text,uuid,boolean,boolean,integer)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.create_public_booking_for_desk_with_staff_notification(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text,uuid,boolean,boolean,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'service-role desk mutation RPC grant boundary drifted';
  END IF;
END $$;

SELECT 'PASS branch tenant isolation static boundary' AS result;
