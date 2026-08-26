\set ON_ERROR_STOP on

-- Disposable, transaction-local rehearsal. It captures outbox work only; no
-- worker is invoked and therefore no SMS/email provider can be reached.
BEGIN;
INSERT INTO public.service_categories(slug,name_en,name_vi)
VALUES('staff-offboarding-durable-qa','Staff offboarding durable','Staff offboarding durable');
INSERT INTO public.salons(
  id,slug,name,phone,timezone,sms_outbound_enabled,email_outbound_enabled
) VALUES(
  'd6400000-0000-4000-8000-000000000001','e2e-staff-offboarding-durable',
  'E2E Staff offboarding durable','+16045550640','UTC',true,true
);
INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
VALUES(
  'd6400000-0000-4000-8000-000000000002',
  'd6400000-0000-4000-8000-000000000001','Durable service',3000,30,
  'staff-offboarding-durable-qa'
);
INSERT INTO public.staff(id,salon_id,name,status) VALUES
 ('d6400000-0000-4000-8000-000000000003',
  'd6400000-0000-4000-8000-000000000001','Departing staff','active'),
 ('d6400000-0000-4000-8000-000000000004',
  'd6400000-0000-4000-8000-000000000001','Replacement staff','active');
INSERT INTO auth.users(
  id,email,encrypted_password,email_confirmed_at,raw_app_meta_data,
  raw_user_meta_data,created_at
) VALUES(
  'd6400000-0000-4000-8000-000000000005',
  'staff-offboarding-durable@nailiq.invalid','',now(),
  '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,now()
);
INSERT INTO public.salon_members(salon_id,user_id,role)
VALUES(
  'd6400000-0000-4000-8000-000000000001',
  'd6400000-0000-4000-8000-000000000005','owner'
);
INSERT INTO public.bookings(
  id,salon_id,service_id,staff_id,client_name,client_phone,client_email,
  start_time_utc,end_time_utc,status,price_cents
) VALUES(
  'd6400000-0000-4000-8000-000000000020',
  'd6400000-0000-4000-8000-000000000001',
  'd6400000-0000-4000-8000-000000000002',
  'd6400000-0000-4000-8000-000000000003','Durable guest',
  '+16045550641','durable@example.test',now()+interval '2 days',
  now()+interval '2 days 30 minutes','confirmed',3000
);

SELECT set_config('request.jwt.claim.role','service_role',true);
DO $rehearsal$
DECLARE v_result jsonb; v_replay jsonb; v_mismatch jsonb;
BEGIN
  BEGIN
    UPDATE public.staff SET status='pending'
    WHERE id='d6400000-0000-4000-8000-000000000003';
    RAISE EXCEPTION 'direct pending transition ignored parent assignment';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'staff with live bookings must be offboarded atomically' THEN RAISE; END IF;
  END;
  IF (SELECT status FROM public.staff
      WHERE id='d6400000-0000-4000-8000-000000000003')<>'active' THEN
    RAISE EXCEPTION 'failed pending invariant changed target row';
  END IF;

  v_result:=public.offboard_staff_with_durable_notifications(
    'd6400000-0000-4000-8000-000000000001',
    'd6400000-0000-4000-8000-000000000003',
    'd6400000-0000-4000-8000-000000000011',
    'd6400000-0000-4000-8000-000000000005','owner',
    '[{"booking_id":"d6400000-0000-4000-8000-000000000020","staff_id":"d6400000-0000-4000-8000-000000000004"}]'::jsonb,
    true,true,false,20
  );
  IF v_result->>'code'<>'staff_offboarded'
     OR (v_result->>'idempotent')::boolean
     OR (v_result->>'reassigned_count')::integer<>1
     OR (v_result->>'audit_events_recorded')::integer<>1
     OR (v_result->>'notification_events_queued')::integer<>1
     OR (v_result->>'notification_deliveries_queued')::integer<>2 THEN
    RAISE EXCEPTION 'staff offboarding result mismatch: %',v_result;
  END IF;
  IF (SELECT status FROM public.staff
      WHERE id='d6400000-0000-4000-8000-000000000003')<>'inactive'
     OR (SELECT staff_id FROM public.bookings
      WHERE id='d6400000-0000-4000-8000-000000000020')<>
        'd6400000-0000-4000-8000-000000000004'::uuid
     OR EXISTS (SELECT 1 FROM public.bookings
      WHERE id='d6400000-0000-4000-8000-000000000020'
        AND (staff_action_notification_request_id IS NOT NULL
          OR staff_action_notification_actor_user_id IS NOT NULL
          OR staff_action_notification_actor_role IS NOT NULL
          OR staff_action_notification_channels IS NOT NULL
          OR staff_action_notification_delay_seconds IS NOT NULL)) THEN
    RAISE EXCEPTION 'staff offboarding mutation/ephemeral input mismatch';
  END IF;
  IF (SELECT count(*) FROM public.staff_offboarding_receipts
      WHERE request_id='d6400000-0000-4000-8000-000000000011')<>1
     OR (SELECT count(*) FROM public.staff_action_notification_outbox
      WHERE booking_id='d6400000-0000-4000-8000-000000000020'
        AND event_type='staff_change' AND occurrence_version=1)<>1
     OR (SELECT count(*) FROM public.staff_action_notification_deliveries d
      JOIN public.staff_action_notification_outbox o ON o.id=d.outbox_id
      WHERE o.booking_id='d6400000-0000-4000-8000-000000000020'
        AND o.event_type='staff_change' AND d.status='awaiting_material')<>2
     OR (SELECT count(*) FROM public.booking_events e
      WHERE e.booking_id='d6400000-0000-4000-8000-000000000020'
        AND e.staff_offboarding_request_id=
          'd6400000-0000-4000-8000-000000000011')<>1
     OR EXISTS (SELECT 1 FROM public.staff_action_notification_outbox o
      WHERE o.booking_id='d6400000-0000-4000-8000-000000000020'
        AND (
          (o.material_snapshot->>'previous_staff_id')::uuid<>
            'd6400000-0000-4000-8000-000000000003'::uuid
          OR (o.material_snapshot->>'staff_id')::uuid<>
            'd6400000-0000-4000-8000-000000000004'::uuid
        )) THEN
    RAISE EXCEPTION 'staff-change durable outbox mismatch';
  END IF;

  v_replay:=public.offboard_staff_with_durable_notifications(
    'd6400000-0000-4000-8000-000000000001',
    'd6400000-0000-4000-8000-000000000003',
    'd6400000-0000-4000-8000-000000000011',
    'd6400000-0000-4000-8000-000000000005','owner',
    '[{"booking_id":"d6400000-0000-4000-8000-000000000020","staff_id":"d6400000-0000-4000-8000-000000000004"}]'::jsonb,
    true,true,false,20
  );
  IF v_replay->>'code'<>'staff_offboarded'
     OR (v_replay->>'idempotent')::boolean IS NOT TRUE
     OR (v_replay->>'audit_events_recorded')::integer<>1 THEN
    RAISE EXCEPTION 'staff offboarding replay mismatch: %',v_replay;
  END IF;

  v_mismatch:=public.offboard_staff_with_durable_notifications(
    'd6400000-0000-4000-8000-000000000001',
    'd6400000-0000-4000-8000-000000000003',
    'd6400000-0000-4000-8000-000000000011',
    'd6400000-0000-4000-8000-000000000005','owner','[]'::jsonb,
    true,true,false,20
  );
  IF v_mismatch->>'code'<>'idempotency_mismatch' THEN
    RAISE EXCEPTION 'staff offboarding mismatch replay was accepted: %',v_mismatch;
  END IF;
END;$rehearsal$;
ROLLBACK;

SELECT 'PASS atomic staff offboarding and durable staff_change outbox runtime' AS result;
