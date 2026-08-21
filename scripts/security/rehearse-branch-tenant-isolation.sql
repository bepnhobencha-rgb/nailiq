\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users(id,email,created_at) VALUES
  ('51820000-0000-4000-8000-000000000001','branch-a-owner@nailiq.invalid',now()),
  ('51820000-0000-4000-8000-000000000002','branch-b-owner@nailiq.invalid',now());
INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES
  ('51820000-0000-4000-8000-000000000011','51820000-0000-4000-8000-000000000001',now(),now()),
  ('51820000-0000-4000-8000-000000000012','51820000-0000-4000-8000-000000000002',now(),now());

INSERT INTO public.salons(id,slug,name,phone,email,timezone) VALUES
  ('51820000-0000-4000-8000-000000000021','branch-isolation-a','Branch A','+16045550181','a@example.invalid','UTC'),
  ('51820000-0000-4000-8000-000000000022','branch-isolation-b','Branch B','+16045550182','b@example.invalid','UTC');
INSERT INTO public.salon_members(salon_id,user_id,role) VALUES
  ('51820000-0000-4000-8000-000000000021','51820000-0000-4000-8000-000000000001','owner'),
  ('51820000-0000-4000-8000-000000000022','51820000-0000-4000-8000-000000000002','owner');
INSERT INTO public.service_categories(slug,name_en,name_vi)
VALUES('other','Other','Khác') ON CONFLICT(slug) DO NOTHING;
INSERT INTO public.services(id,salon_id,name,duration_minutes,price_cents) VALUES
  ('51820000-0000-4000-8000-000000000031','51820000-0000-4000-8000-000000000021','Service A',30,3000),
  ('51820000-0000-4000-8000-000000000032','51820000-0000-4000-8000-000000000022','Service B',30,4000);
INSERT INTO public.staff(id,salon_id,name,status) VALUES
  ('51820000-0000-4000-8000-000000000041','51820000-0000-4000-8000-000000000021','Staff A','active'),
  ('51820000-0000-4000-8000-000000000042','51820000-0000-4000-8000-000000000022','Staff B','active');
INSERT INTO public.bookings(
  id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status
) VALUES
  ('51820000-0000-4000-8000-000000000051','51820000-0000-4000-8000-000000000021',
   '51820000-0000-4000-8000-000000000031','51820000-0000-4000-8000-000000000041',
   'Client A','+16045550191',now()+interval '10 days',now()+interval '10 days 30 minutes','confirmed'),
  ('51820000-0000-4000-8000-000000000052','51820000-0000-4000-8000-000000000022',
   '51820000-0000-4000-8000-000000000032','51820000-0000-4000-8000-000000000042',
   'Client B','+16045550192',now()+interval '11 days',now()+interval '11 days 30 minutes','confirmed');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim',jsonb_build_object(
  'role','authenticated','aud','authenticated','sub','51820000-0000-4000-8000-000000000001',
  'session_id','51820000-0000-4000-8000-000000000011',
  'exp',floor(extract(epoch FROM now()))::bigint+600)::text,true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','51820000-0000-4000-8000-000000000001',true);

DO $$
DECLARE v_count integer; v_result jsonb;
BEGIN
  SELECT count(*) INTO v_count FROM public.bookings;
  IF v_count<>1 OR NOT EXISTS(SELECT 1 FROM public.bookings WHERE id='51820000-0000-4000-8000-000000000051') THEN
    RAISE EXCEPTION 'booking read crossed branch boundary: %',v_count;
  END IF;
  SELECT count(*) INTO v_count FROM public.services;
  IF v_count<>1 OR NOT EXISTS(SELECT 1 FROM public.services WHERE id='51820000-0000-4000-8000-000000000031') THEN
    RAISE EXCEPTION 'service read crossed branch boundary: %',v_count;
  END IF;
  SELECT count(*) INTO v_count FROM public.staff;
  IF v_count<>1 OR NOT EXISTS(SELECT 1 FROM public.staff WHERE id='51820000-0000-4000-8000-000000000041') THEN
    RAISE EXCEPTION 'staff read crossed branch boundary: %',v_count;
  END IF;
  SELECT count(*) INTO v_count FROM public.salons;
  IF v_count<>1 OR NOT EXISTS(SELECT 1 FROM public.salons WHERE id='51820000-0000-4000-8000-000000000021') THEN
    RAISE EXCEPTION 'salon read crossed branch boundary: %',v_count;
  END IF;

  UPDATE public.bookings SET client_name='cross-branch-write'
  WHERE id='51820000-0000-4000-8000-000000000052';
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>0 THEN RAISE EXCEPTION 'cross-branch booking update succeeded'; END IF;

  BEGIN
    UPDATE public.bookings SET salon_id='51820000-0000-4000-8000-000000000022'
    WHERE id='51820000-0000-4000-8000-000000000051';
    RAISE EXCEPTION 'booking was re-parented into another branch';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.services SET salon_id='51820000-0000-4000-8000-000000000022'
    WHERE id='51820000-0000-4000-8000-000000000031';
    RAISE EXCEPTION 'service was re-parented into another branch';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.staff SET salon_id='51820000-0000-4000-8000-000000000022'
    WHERE id='51820000-0000-4000-8000-000000000041';
    RAISE EXCEPTION 'staff row was re-parented into another branch';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.bookings(
      id,salon_id,service_id,staff_id,client_name,client_phone,start_time_utc,end_time_utc,status
    ) VALUES(
      '51820000-0000-4000-8000-000000000053','51820000-0000-4000-8000-000000000022',
      '51820000-0000-4000-8000-000000000032','51820000-0000-4000-8000-000000000042',
      'Cross branch','+16045550193',now()+interval '12 days',now()+interval '12 days 30 minutes','confirmed');
    RAISE EXCEPTION 'cross-branch booking insert succeeded';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL;
  END;

  BEGIN
    TRUNCATE public.bookings;
    RAISE EXCEPTION 'authenticated role truncated tenant bookings';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  v_result:=public.load_salon_member_operational_profile('51820000-0000-4000-8000-000000000022');
  IF v_result->>'code'<>'forbidden' THEN
    RAISE EXCEPTION 'member RPC crossed branch boundary: %',v_result;
  END IF;
  v_result:=public.load_salon_owner_admin_settings('51820000-0000-4000-8000-000000000022');
  IF v_result->>'code'<>'forbidden' THEN
    RAISE EXCEPTION 'owner RPC crossed branch boundary: %',v_result;
  END IF;
END $$;

RESET ROLE;
DO $$
DECLARE v_name text;
BEGIN
  SELECT client_name INTO v_name FROM public.bookings
  WHERE id='51820000-0000-4000-8000-000000000052';
  IF v_name<>'Client B' THEN RAISE EXCEPTION 'cross-branch write changed branch B'; END IF;
END $$;

-- service_role may bypass RLS for trusted workers, but browser principals cannot
-- invoke the service-only durable mutation contract directly. The desk wrapper
-- itself intersects actor membership with p_salon_id before any mutation.
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
DO $$
DECLARE v_result jsonb;
BEGIN
  v_result:=public.create_public_booking_for_desk_with_staff_notification(
    '51820000-0000-4000-8000-000000000022','51820000-0000-4000-8000-000000000032',
    '51820000-0000-4000-8000-000000000042','Service cross branch','+16045550194',
    now()+interval '13 days',now()+interval '13 days 30 minutes','confirmed',NULL,
    '{}'::uuid[],NULL,NULL,NULL,NULL,false,'51820000-0000-4000-8000-000000000061',
    NULL,'51820000-0000-4000-8000-000000000001',false,false,5);
  IF v_result->>'code'<>'actor_unauthorized' THEN
    RAISE EXCEPTION 'service-role wrapper trusted cross-branch actor: %',v_result;
  END IF;
  IF EXISTS(SELECT 1 FROM public.bookings WHERE id='51820000-0000-4000-8000-000000000061') THEN
    RAISE EXCEPTION 'cross-branch service wrapper wrote a booking';
  END IF;
END $$;

ROLLBACK;
SELECT 'PASS branch tenant isolation reads, writes, RPCs and table-control boundary' AS result;
