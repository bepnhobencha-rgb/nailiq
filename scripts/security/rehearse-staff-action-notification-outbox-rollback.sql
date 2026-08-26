\set ON_ERROR_STOP on

-- Forced failure after every booking row and the organizer outbox were written
-- must roll back the whole-party lifecycle, duplicate legacy occurrence cleanup
-- and the outbox together.
BEGIN;
INSERT INTO public.service_categories(slug,name_en,name_vi)
VALUES('staff-action-rollback-qa','Staff action rollback','Staff action rollback');
INSERT INTO public.salons(id,slug,name,phone,timezone)
VALUES('d6300000-0000-4000-8000-000000000001','e2e-staff-action-rollback',
  'E2E Staff action rollback','+16045550630','UTC');
INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
VALUES('d6300000-0000-4000-8000-000000000002',
  'd6300000-0000-4000-8000-000000000001','Rollback service',3000,30,
  'staff-action-rollback-qa');
INSERT INTO public.staff(id,salon_id,name,status) VALUES
 ('d6300000-0000-4000-8000-000000000003','d6300000-0000-4000-8000-000000000001','Rollback 1','active'),
 ('d6300000-0000-4000-8000-000000000004','d6300000-0000-4000-8000-000000000001','Rollback 2','active');
INSERT INTO auth.users(id,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at)
VALUES('d6300000-0000-4000-8000-000000000005','staff-action-rollback@nailiq.invalid','',now(),
  '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now());
INSERT INTO public.salon_members(salon_id,user_id,role)
VALUES('d6300000-0000-4000-8000-000000000001',
  'd6300000-0000-4000-8000-000000000005','receptionist');
INSERT INTO public.bookings(id,salon_id,service_id,staff_id,client_name,client_phone,
  client_email,start_time_utc,end_time_utc,status,price_cents,group_id,group_size,
  is_party_member,is_group_organizer) VALUES
 ('d6300000-0000-4000-8000-000000000020','d6300000-0000-4000-8000-000000000001',
  'd6300000-0000-4000-8000-000000000002','d6300000-0000-4000-8000-000000000003',
  'Rollback lead','+16045550631','rollback@example.test',now()+interval '2 days',
  now()+interval '2 days 30 minutes','confirmed',3000,
  'd6300000-0000-4000-8000-000000000010',2,true,true),
 ('d6300000-0000-4000-8000-000000000021','d6300000-0000-4000-8000-000000000001',
  'd6300000-0000-4000-8000-000000000002','d6300000-0000-4000-8000-000000000004',
  'Rollback member',NULL,NULL,now()+interval '2 days',now()+interval '2 days 30 minutes',
  'confirmed',3000,'d6300000-0000-4000-8000-000000000010',2,true,false);
CREATE FUNCTION pg_temp.fail_staff_action_group_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'forced receipt failure'; END$$;
CREATE TRIGGER qa_fail_staff_action_group_receipt
BEFORE INSERT ON public.staff_action_group_cancel_receipts
FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_staff_action_group_receipt();
SELECT set_config('request.jwt.claim.role','service_role',true);
DO $forced$
BEGIN
  BEGIN
    PERFORM public.cancel_booking_group_for_desk_with_staff_notification(
      'd6300000-0000-4000-8000-000000000001',
      'd6300000-0000-4000-8000-000000000010',
      'd6300000-0000-4000-8000-000000000011',
      'd6300000-0000-4000-8000-000000000005',true,true,20);
    RAISE EXCEPTION 'forced group failure unexpectedly committed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='forced group failure unexpectedly committed' THEN RAISE; END IF;
  END;
  IF (SELECT count(*) FROM public.bookings WHERE group_id=
       'd6300000-0000-4000-8000-000000000010' AND status='confirmed')<>2
     OR EXISTS(SELECT 1 FROM public.staff_action_notification_outbox
       WHERE request_id='d6300000-0000-4000-8000-000000000011')
     OR EXISTS(SELECT 1 FROM public.staff_action_group_cancel_receipts
       WHERE request_id='d6300000-0000-4000-8000-000000000011')
     OR EXISTS(SELECT 1 FROM public.customer_booking_transition_email_outbox x
       JOIN public.bookings b ON b.id=x.booking_id
       WHERE b.group_id='d6300000-0000-4000-8000-000000000010') THEN
    RAISE EXCEPTION 'forced producer failure left torn booking/outbox state';
  END IF;
END;$forced$;
ROLLBACK;

BEGIN;
DROP FUNCTION public.reschedule_booking_sequence_for_desk(
  uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text);
ALTER FUNCTION public.reschedule_booking_sequence_for_desk_pre_staff_outbox(
  uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)
  RENAME TO reschedule_booking_sequence_for_desk;
DROP FUNCTION public.replay_booking_sequence_reschedule_for_desk(
  uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text);
ALTER FUNCTION public.replay_booking_sequence_reschedule_for_desk_pre_staff_outbox(
  uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)
  RENAME TO replay_booking_sequence_reschedule_for_desk;
DROP TRIGGER zz_capture_staff_action_notification_occurrence ON public.bookings;
DROP TABLE public.staff_action_group_cancel_receipts CASCADE;
DROP TABLE public.staff_action_notification_envelopes CASCADE;
DROP TABLE public.staff_action_notification_deliveries CASCADE;
DROP TABLE public.staff_action_notification_outbox CASCADE;
ALTER TABLE public.bookings DROP COLUMN staff_action_notification_request_id,
  DROP COLUMN staff_action_notification_actor_user_id,
  DROP COLUMN staff_action_notification_actor_role,
  DROP COLUMN staff_action_notification_channels,
  DROP COLUMN staff_action_notification_delay_seconds;
ROLLBACK;

DO $verify$
BEGIN
  IF to_regclass('public.staff_action_notification_outbox') IS NULL
     OR to_regprocedure('public.create_public_booking_for_desk_with_staff_notification(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,uuid[],text,uuid,uuid,uuid,boolean,uuid,text,uuid,boolean,boolean,integer)') IS NULL
     OR to_regprocedure('public.reschedule_booking_sequence_for_desk_pre_staff_outbox(uuid,uuid,uuid,boolean,boolean,uuid,timestamptz,text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.bookings'::regclass
       AND tgname='zz_capture_staff_action_notification_occurrence' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'staff-action schema rollback rehearsal did not restore current contract';
  END IF;
END;$verify$;

SELECT 'PASS staff-action notification schema rollback is transactional' AS result;
