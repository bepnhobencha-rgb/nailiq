\set ON_ERROR_STOP on

-- A receipt failure occurs after booking reassignment, optional access revoke,
-- staff deactivation and outbox capture in function order. Catching that forced
-- error must still leave every participating row at its pre-call value.
BEGIN;
INSERT INTO public.service_categories(slug,name_en,name_vi)
VALUES('staff-offboarding-rollback-qa','Staff offboarding rollback','Staff offboarding rollback');
INSERT INTO public.salons(
  id,slug,name,phone,timezone,sms_outbound_enabled,email_outbound_enabled
) VALUES(
  'd6500000-0000-4000-8000-000000000001','e2e-staff-offboarding-rollback',
  'E2E Staff offboarding rollback','+16045550650','UTC',true,true
);
INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
VALUES(
  'd6500000-0000-4000-8000-000000000002',
  'd6500000-0000-4000-8000-000000000001','Rollback service',3000,30,
  'staff-offboarding-rollback-qa'
);
INSERT INTO auth.users(
  id,email,encrypted_password,email_confirmed_at,raw_app_meta_data,
  raw_user_meta_data,created_at
) VALUES
 ('d6500000-0000-4000-8000-000000000005','offboarding-owner@nailiq.invalid','',now(),
  '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now()),
 ('d6500000-0000-4000-8000-000000000006','offboarding-target@nailiq.invalid','',now(),
  '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now());
INSERT INTO public.staff(id,salon_id,name,status,user_id) VALUES
 ('d6500000-0000-4000-8000-000000000003',
  'd6500000-0000-4000-8000-000000000001','Rollback departing','active',
  'd6500000-0000-4000-8000-000000000006'),
 ('d6500000-0000-4000-8000-000000000004',
  'd6500000-0000-4000-8000-000000000001','Rollback replacement','active',NULL);
INSERT INTO public.salon_members(salon_id,user_id,role) VALUES
 ('d6500000-0000-4000-8000-000000000001',
  'd6500000-0000-4000-8000-000000000005','owner'),
 ('d6500000-0000-4000-8000-000000000001',
  'd6500000-0000-4000-8000-000000000006','admin');
INSERT INTO public.bookings(
  id,salon_id,service_id,staff_id,client_name,client_phone,client_email,
  start_time_utc,end_time_utc,status,price_cents
) VALUES(
  'd6500000-0000-4000-8000-000000000020',
  'd6500000-0000-4000-8000-000000000001',
  'd6500000-0000-4000-8000-000000000002',
  'd6500000-0000-4000-8000-000000000003','Rollback guest',
  '+16045550651','rollback@example.test',now()+interval '2 days',
  now()+interval '2 days 30 minutes','confirmed',3000
);
CREATE FUNCTION pg_temp.fail_staff_offboarding_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'forced staff offboarding receipt failure';
END$$;
CREATE TRIGGER qa_fail_staff_offboarding_receipt
BEFORE INSERT ON public.staff_offboarding_receipts
FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_staff_offboarding_receipt();
SELECT set_config('request.jwt.claim.role','service_role',true);
DO $forced$
BEGIN
  BEGIN
    PERFORM public.offboard_staff_with_durable_notifications(
      'd6500000-0000-4000-8000-000000000001',
      'd6500000-0000-4000-8000-000000000003',
      'd6500000-0000-4000-8000-000000000011',
      'd6500000-0000-4000-8000-000000000005','owner',
      '[{"booking_id":"d6500000-0000-4000-8000-000000000020","staff_id":"d6500000-0000-4000-8000-000000000004"}]'::jsonb,
      true,true,true,20
    );
    RAISE EXCEPTION 'forced staff offboarding failure unexpectedly committed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM='forced staff offboarding failure unexpectedly committed' THEN RAISE; END IF;
  END;

  IF (SELECT status FROM public.staff
      WHERE id='d6500000-0000-4000-8000-000000000003')<>'active'
     OR (SELECT user_id FROM public.staff
      WHERE id='d6500000-0000-4000-8000-000000000003')<>
        'd6500000-0000-4000-8000-000000000006'::uuid
     OR NOT EXISTS (SELECT 1 FROM public.salon_members
      WHERE salon_id='d6500000-0000-4000-8000-000000000001'
        AND user_id='d6500000-0000-4000-8000-000000000006' AND role='admin')
     OR (SELECT staff_id FROM public.bookings
      WHERE id='d6500000-0000-4000-8000-000000000020')<>
        'd6500000-0000-4000-8000-000000000003'::uuid
     OR EXISTS (SELECT 1 FROM public.staff_action_notification_outbox
      WHERE booking_id='d6500000-0000-4000-8000-000000000020')
     OR EXISTS (SELECT 1 FROM public.staff_offboarding_receipts
      WHERE request_id='d6500000-0000-4000-8000-000000000011')
     OR EXISTS (SELECT 1 FROM public.booking_events
      WHERE staff_offboarding_request_id=
        'd6500000-0000-4000-8000-000000000011') THEN
    RAISE EXCEPTION 'forced receipt failure left torn offboarding state';
  END IF;
END;$forced$;
ROLLBACK;

-- Transactional DDL rehearsal only. This proves a failed local transaction
-- restores the current contract; it is not a supported production downgrade.
BEGIN;
DROP TRIGGER enforce_no_live_assignments_before_staff_deactivation
  ON public.staff;
DROP FUNCTION public.enforce_no_live_assignments_on_staff_deactivation();
DROP TRIGGER enforce_active_staff_for_live_single_booking ON public.bookings;
DROP TRIGGER enforce_active_staff_for_live_sequence_segment
  ON public.booking_service_segments;
DROP FUNCTION public.enforce_active_staff_for_live_booking();
DROP TRIGGER zy_capture_staff_change_notification_occurrence ON public.bookings;
DROP FUNCTION public.capture_staff_change_notification_occurrence();
DROP FUNCTION public.recover_staff_offboarding_with_durable_notifications(
  uuid,uuid,uuid,uuid,text
);
DROP FUNCTION public.offboard_staff_with_durable_notifications(
  uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer
);
DROP FUNCTION public.offboard_staff_with_durable_notifications_v3_impl(
  uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer
);
DROP FUNCTION public.ensure_staff_offboarding_booking_events(
  uuid,uuid,uuid,uuid,text,jsonb
);
DROP FUNCTION public.staff_offboarding_notification_request_id(uuid,uuid);
DROP TABLE public.staff_offboarding_receipts;
DROP INDEX public.booking_events_staff_offboarding_request_booking_uidx;
ALTER TABLE public.booking_events
  DROP CONSTRAINT booking_events_staff_offboarding_request_check,
  DROP COLUMN staff_offboarding_request_id;
ALTER TABLE public.staff_action_notification_outbox
  DROP CONSTRAINT staff_action_notification_outbox_event_type_check;
ALTER TABLE public.staff_action_notification_outbox
  ADD CONSTRAINT staff_action_notification_outbox_event_type_check
  CHECK (event_type IN ('create','reschedule','cancel')) NOT VALID;
ROLLBACK;

DO $verify$
BEGIN
  IF to_regclass('public.staff_offboarding_receipts') IS NULL
     OR to_regprocedure('public.offboard_staff_with_durable_notifications(uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer)') IS NULL
     OR to_regprocedure('public.offboard_staff_with_durable_notifications_v3_impl(uuid,uuid,uuid,uuid,text,jsonb,boolean,boolean,boolean,integer)') IS NULL
     OR to_regprocedure('public.recover_staff_offboarding_with_durable_notifications(uuid,uuid,uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.ensure_staff_offboarding_booking_events(uuid,uuid,uuid,uuid,text,jsonb)') IS NULL
     OR to_regprocedure('public.capture_staff_change_notification_occurrence()') IS NULL
     OR to_regprocedure('public.enforce_active_staff_for_live_booking()') IS NULL
     OR to_regprocedure('public.enforce_no_live_assignments_on_staff_deactivation()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
       WHERE tgrelid='public.bookings'::regclass
         AND tgname='zy_capture_staff_change_notification_occurrence' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
       WHERE tgrelid='public.bookings'::regclass
         AND tgname='enforce_active_staff_for_live_single_booking' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
       WHERE tgrelid='public.booking_service_segments'::regclass
         AND tgname='enforce_active_staff_for_live_sequence_segment' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
       WHERE tgrelid='public.staff'::regclass
         AND tgname='enforce_no_live_assignments_before_staff_deactivation'
         AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='booking_events'
         AND column_name='staff_offboarding_request_id')
     OR NOT (SELECT c.relforcerowsecurity FROM pg_class c
       WHERE c.oid='public.staff_offboarding_receipts'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c
       WHERE c.conrelid='public.staff_action_notification_outbox'::regclass
         AND c.conname='staff_action_notification_outbox_event_type_check'
         AND position('staff_change' IN pg_get_constraintdef(c.oid))>0) THEN
    RAISE EXCEPTION 'staff offboarding schema rollback did not restore current contract';
  END IF;
END;$verify$;

SELECT 'PASS staff offboarding mutation/outbox and schema rollback are transactional' AS result;
