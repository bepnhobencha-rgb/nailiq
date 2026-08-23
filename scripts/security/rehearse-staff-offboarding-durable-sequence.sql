\set ON_ERROR_STOP on

-- Disposable multi-service rehearsal. All rows and outbox material roll back;
-- no worker or provider is invoked.
BEGIN;
SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',true);

INSERT INTO public.service_categories(slug,name_en,name_vi)
VALUES('staff-offboarding-sequence-qa','Staff offboarding sequence','Staff offboarding sequence');

INSERT INTO public.salons(
  id,slug,name,phone,timezone,sms_outbound_enabled,email_outbound_enabled
) VALUES(
  'd6700000-0000-4000-8000-000000000001','e2e-staff-offboarding-sequence',
  'E2E Staff offboarding sequence','+16045550670','UTC',false,true
);
INSERT INTO public.salons(
  id,slug,name,phone,timezone,sms_outbound_enabled,email_outbound_enabled
) VALUES(
  'd6700000-0000-4000-8000-000000000002','e2e-staff-offboarding-sequence-other',
  'E2E Staff offboarding sequence other','+16045550679','UTC',false,false
);

INSERT INTO public.services(
  id,salon_id,name,price_cents,duration_minutes,category
) VALUES
 ('d6700000-0000-4000-8000-000000000010',
  'd6700000-0000-4000-8000-000000000001','Sequence service one',1000,30,
  'staff-offboarding-sequence-qa'),
 ('d6700000-0000-4000-8000-000000000011',
  'd6700000-0000-4000-8000-000000000001','Sequence service two',2000,30,
  'staff-offboarding-sequence-qa');

INSERT INTO public.staff(id,salon_id,name,status) VALUES
 ('d6700000-0000-4000-8000-000000000020',
  'd6700000-0000-4000-8000-000000000001','Sequence departing','active'),
 ('d6700000-0000-4000-8000-000000000021',
  'd6700000-0000-4000-8000-000000000001','Sequence anchor','active'),
 ('d6700000-0000-4000-8000-000000000022',
  'd6700000-0000-4000-8000-000000000001','Sequence replacement','active'),
 ('d6700000-0000-4000-8000-000000000023',
  'd6700000-0000-4000-8000-000000000001','Sequence incapable','active'),
 ('d6700000-0000-4000-8000-000000000024',
  'd6700000-0000-4000-8000-000000000001','Sequence no-live tenant locked','active'),
 ('d6700000-0000-4000-8000-000000000025',
  'd6700000-0000-4000-8000-000000000001','Sequence legacy pending drift','active'),
 ('d6700000-0000-4000-8000-000000000026',
  'd6700000-0000-4000-8000-000000000001','Sequence pending profile','pending');

-- Once any active staff capability exists, every candidate must be mapped to
-- every affected service. The incapable candidate intentionally lacks service two.
INSERT INTO public.staff_services(staff_id,service_id) VALUES
 ('d6700000-0000-4000-8000-000000000020','d6700000-0000-4000-8000-000000000010'),
 ('d6700000-0000-4000-8000-000000000020','d6700000-0000-4000-8000-000000000011'),
 ('d6700000-0000-4000-8000-000000000021','d6700000-0000-4000-8000-000000000010'),
 ('d6700000-0000-4000-8000-000000000021','d6700000-0000-4000-8000-000000000011'),
 ('d6700000-0000-4000-8000-000000000022','d6700000-0000-4000-8000-000000000010'),
 ('d6700000-0000-4000-8000-000000000022','d6700000-0000-4000-8000-000000000011'),
 ('d6700000-0000-4000-8000-000000000023','d6700000-0000-4000-8000-000000000010'),
 ('d6700000-0000-4000-8000-000000000024','d6700000-0000-4000-8000-000000000010');

INSERT INTO public.staff_shifts(
  staff_id,salon_id,day_of_week,start_time,end_time,is_active
) VALUES(
  'd6700000-0000-4000-8000-000000000024',
  'd6700000-0000-4000-8000-000000000001','mon','09:00','17:00',true
);

INSERT INTO auth.users(
  id,email,encrypted_password,email_confirmed_at,raw_app_meta_data,
  raw_user_meta_data,created_at
) VALUES(
  'd6700000-0000-4000-8000-000000000030',
  'staff-offboarding-sequence@nailiq.invalid','',transaction_timestamp(),
  '{"provider":"email","providers":["email"]}'::jsonb,'{}'::jsonb,
  transaction_timestamp()
);
INSERT INTO public.salon_members(salon_id,user_id,role) VALUES(
  'd6700000-0000-4000-8000-000000000001',
  'd6700000-0000-4000-8000-000000000030','owner'
);

-- Exercise the exact browser/RLS boundary on a zero-live staff row. Ordinary
-- profile edits remain available to the owner, while every lifecycle bypass
-- fails before it can evade the atomic receipt/minimum-active contract.
SELECT pg_catalog.set_config('request.jwt.claim.role','authenticated',true);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub','d6700000-0000-4000-8000-000000000030',true
);
SELECT pg_catalog.set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"d6700000-0000-4000-8000-000000000030"}',
  true
);
SET LOCAL ROLE authenticated;
DO $authenticated_staff_lifecycle_boundary$
BEGIN
  UPDATE public.staff
  SET name='Sequence no-live tenant locked edited'
  WHERE id='d6700000-0000-4000-8000-000000000024';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authenticated owner could not edit an ordinary staff field';
  END IF;
  UPDATE public.staff
  SET name='Sequence no-live tenant locked'
  WHERE id='d6700000-0000-4000-8000-000000000024';

  UPDATE public.staff SET status='inactive'
  WHERE id='d6700000-0000-4000-8000-000000000026';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'authenticated pending profile could not become inactive';
  END IF;
  UPDATE public.staff SET status='pending'
  WHERE id='d6700000-0000-4000-8000-000000000026';

  BEGIN
    UPDATE public.staff SET status='pending'
    WHERE id='d6700000-0000-4000-8000-000000000024';
    RAISE EXCEPTION 'authenticated zero-live pending transition bypassed atomic offboarding';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'staff lifecycle changes require atomic offboarding' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.staff SET status='inactive'
    WHERE id='d6700000-0000-4000-8000-000000000024';
    RAISE EXCEPTION 'authenticated zero-live inactive transition bypassed atomic offboarding';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'staff lifecycle changes require atomic offboarding' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.staff SET deleted_at=transaction_timestamp()
    WHERE id='d6700000-0000-4000-8000-000000000024';
    RAISE EXCEPTION 'authenticated zero-live soft delete bypassed atomic offboarding';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'staff lifecycle changes require atomic offboarding' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM public.staff
    WHERE id='d6700000-0000-4000-8000-000000000024';
    RAISE EXCEPTION 'authenticated zero-live hard delete retained table privilege';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  IF NOT EXISTS (
    SELECT 1 FROM public.staff
    WHERE id='d6700000-0000-4000-8000-000000000024'
      AND name='Sequence no-live tenant locked'
      AND status='active' AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'rejected authenticated lifecycle write changed target row';
  END IF;
END;
$authenticated_staff_lifecycle_boundary$;
RESET ROLE;
SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',true);
SELECT pg_catalog.set_config('request.jwt.claim.sub','',true);
SELECT pg_catalog.set_config(
  'request.jwt.claims','{"role":"service_role"}',true
);

-- Booking A: departing staff is only on the later segment, so the parent
-- anchor must remain unchanged while the authoritative segment moves.
INSERT INTO public.bookings(
  id,salon_id,service_id,staff_id,client_name,client_phone,client_email,
  start_time_utc,end_time_utc,status,source,price_cents,original_price_cents,
  subtotal_cents,tax_amount_cents,schedule_model,sequence_version,
  public_booking_request_fingerprint,public_booking_pricing_fingerprint,
  public_booking_pricing_snapshot
) VALUES(
  'd6700000-0000-4000-8000-000000000040',
  'd6700000-0000-4000-8000-000000000001',
  'd6700000-0000-4000-8000-000000000010',
  'd6700000-0000-4000-8000-000000000021','Sequence later guest',
  '+16045550671','sequence-later@example.test',
  date_trunc('day',transaction_timestamp()+interval '5 days')+interval '10 hours',
  date_trunc('day',transaction_timestamp()+interval '5 days')+interval '11 hours',
  'confirmed','appointment',3000,3000,3000,0,'segments_v1',1,
  repeat('b',64),repeat('a',64),
  pg_catalog.jsonb_build_object(
    'success',true,'code','quoted','request_id','d6700000-0000-4000-8000-000000000140',
    'pricing_fingerprint',repeat('a',64),'contract_version',1,
    'schedule_model','segments_v1','sequence_version',1,
    'salon_id','d6700000-0000-4000-8000-000000000001',
    'segments',pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'line_id','d6700000-0000-4000-8000-000000000050','position',0,
        'service_id','d6700000-0000-4000-8000-000000000010',
        'staff_id','d6700000-0000-4000-8000-000000000021',
        'resolved_staff_id','d6700000-0000-4000-8000-000000000021',
        'staff_name','Sequence anchor'
      ),
      pg_catalog.jsonb_build_object(
        'line_id','d6700000-0000-4000-8000-000000000051','position',1,
        'service_id','d6700000-0000-4000-8000-000000000011',
        'staff_id','d6700000-0000-4000-8000-000000000020',
        'resolved_staff_id','d6700000-0000-4000-8000-000000000020',
        'staff_name','Sequence departing'
      )
    ),
    'timing_segments',pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'line_id','d6700000-0000-4000-8000-000000000050','position',0,
        'resolved_staff_id','d6700000-0000-4000-8000-000000000021'
      ),
      pg_catalog.jsonb_build_object(
        'line_id','d6700000-0000-4000-8000-000000000051','position',1,
        'resolved_staff_id','d6700000-0000-4000-8000-000000000020'
      )
    ),
    'reschedule_intent',pg_catalog.jsonb_build_object(
      'same_staff_for_all',false,'lines',pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_id','d6700000-0000-4000-8000-000000000050','position',0,
          'service_id','d6700000-0000-4000-8000-000000000010',
          'staff_preference','d6700000-0000-4000-8000-000000000021',
          'preferred_resource_id',NULL,'addon_service_ids','[]'::jsonb
        ),
        pg_catalog.jsonb_build_object(
          'line_id','d6700000-0000-4000-8000-000000000051','position',1,
          'service_id','d6700000-0000-4000-8000-000000000011',
          'staff_preference','d6700000-0000-4000-8000-000000000020',
          'preferred_resource_id',NULL,'addon_service_ids','[]'::jsonb
        )
      )
    ),
    'segment_ids',pg_catalog.jsonb_build_array(
      'd6700000-0000-4000-8000-000000000060',
      'd6700000-0000-4000-8000-000000000061'
    )
  )
);

-- Booking B: departing staff is segment zero, so parent and segment must move
-- together under the canonical sequence mutation GUC without a 55000 guard.
INSERT INTO public.bookings(
  id,salon_id,service_id,staff_id,client_name,client_phone,client_email,
  start_time_utc,end_time_utc,status,source,price_cents,original_price_cents,
  subtotal_cents,tax_amount_cents,schedule_model,sequence_version,
  public_booking_request_fingerprint,public_booking_pricing_fingerprint,
  public_booking_pricing_snapshot
) VALUES(
  'd6700000-0000-4000-8000-000000000041',
  'd6700000-0000-4000-8000-000000000001',
  'd6700000-0000-4000-8000-000000000010',
  'd6700000-0000-4000-8000-000000000020','Sequence first guest',
  '+16045550672','sequence-first@example.test',
  date_trunc('day',transaction_timestamp()+interval '6 days')+interval '10 hours',
  date_trunc('day',transaction_timestamp()+interval '6 days')+interval '11 hours',
  'confirmed','appointment',3000,3000,3000,0,'segments_v1',1,
  repeat('d',64),repeat('c',64),
  pg_catalog.jsonb_build_object(
    'success',true,'code','quoted','request_id','d6700000-0000-4000-8000-000000000141',
    'pricing_fingerprint',repeat('c',64),'contract_version',1,
    'schedule_model','segments_v1','sequence_version',1,
    'salon_id','d6700000-0000-4000-8000-000000000001',
    'segments',pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'line_id','d6700000-0000-4000-8000-000000000052','position',0,
        'service_id','d6700000-0000-4000-8000-000000000010',
        'staff_id','d6700000-0000-4000-8000-000000000020',
        'resolved_staff_id','d6700000-0000-4000-8000-000000000020',
        'staff_name','Sequence departing'
      ),
      pg_catalog.jsonb_build_object(
        'line_id','d6700000-0000-4000-8000-000000000053','position',1,
        'service_id','d6700000-0000-4000-8000-000000000011',
        'staff_id','d6700000-0000-4000-8000-000000000021',
        'resolved_staff_id','d6700000-0000-4000-8000-000000000021',
        'staff_name','Sequence anchor'
      )
    ),
    'timing_segments',pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'line_id','d6700000-0000-4000-8000-000000000052','position',0,
        'resolved_staff_id','d6700000-0000-4000-8000-000000000020'
      ),
      pg_catalog.jsonb_build_object(
        'line_id','d6700000-0000-4000-8000-000000000053','position',1,
        'resolved_staff_id','d6700000-0000-4000-8000-000000000021'
      )
    ),
    'reschedule_intent',pg_catalog.jsonb_build_object(
      'same_staff_for_all',false,'lines',pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'line_id','d6700000-0000-4000-8000-000000000052','position',0,
          'service_id','d6700000-0000-4000-8000-000000000010',
          'staff_preference','d6700000-0000-4000-8000-000000000020',
          'preferred_resource_id',NULL,'addon_service_ids','[]'::jsonb
        ),
        pg_catalog.jsonb_build_object(
          'line_id','d6700000-0000-4000-8000-000000000053','position',1,
          'service_id','d6700000-0000-4000-8000-000000000011',
          'staff_preference','d6700000-0000-4000-8000-000000000021',
          'preferred_resource_id',NULL,'addon_service_ids','[]'::jsonb
        )
      )
    ),
    'segment_ids',pg_catalog.jsonb_build_array(
      'd6700000-0000-4000-8000-000000000062',
      'd6700000-0000-4000-8000-000000000063'
    )
  )
);

INSERT INTO public.booking_service_segments(
  id,booking_id,salon_id,position,line_id,service_id,staff_id,
  customer_start_utc,customer_end_utc,occupied_start_utc,occupied_end_utc,
  prep_minutes,service_duration_minutes,sequential_addon_minutes,
  trailing_buffer_minutes,service_name,staff_name,
  original_service_price_cents,service_pre_voucher_cents,addon_pre_voucher_cents,
  promo_discount_cents,email_discount_cents,voucher_discount_cents,
  service_price_cents,addon_price_cents,subtotal_cents,tax_cents,total_cents,
  reservation_status
) VALUES
 ('d6700000-0000-4000-8000-000000000060','d6700000-0000-4000-8000-000000000040',
  'd6700000-0000-4000-8000-000000000001',0,'d6700000-0000-4000-8000-000000000050',
  'd6700000-0000-4000-8000-000000000010','d6700000-0000-4000-8000-000000000021',
  date_trunc('day',transaction_timestamp()+interval '5 days')+interval '10 hours',
  date_trunc('day',transaction_timestamp()+interval '5 days')+interval '10 hours 30 minutes',
  date_trunc('day',transaction_timestamp()+interval '5 days')+interval '10 hours',
  date_trunc('day',transaction_timestamp()+interval '5 days')+interval '10 hours 30 minutes',
  0,30,0,0,'Sequence service one','Sequence anchor',1000,1000,0,0,0,0,1000,0,1000,0,1000,'confirmed'),
 ('d6700000-0000-4000-8000-000000000061','d6700000-0000-4000-8000-000000000040',
  'd6700000-0000-4000-8000-000000000001',1,'d6700000-0000-4000-8000-000000000051',
  'd6700000-0000-4000-8000-000000000011','d6700000-0000-4000-8000-000000000020',
  date_trunc('day',transaction_timestamp()+interval '5 days')+interval '10 hours 30 minutes',
  date_trunc('day',transaction_timestamp()+interval '5 days')+interval '11 hours',
  date_trunc('day',transaction_timestamp()+interval '5 days')+interval '10 hours 30 minutes',
  date_trunc('day',transaction_timestamp()+interval '5 days')+interval '11 hours',
  0,30,0,0,'Sequence service two','Sequence departing',2000,2000,0,0,0,0,2000,0,2000,0,2000,'confirmed'),
 ('d6700000-0000-4000-8000-000000000062','d6700000-0000-4000-8000-000000000041',
  'd6700000-0000-4000-8000-000000000001',0,'d6700000-0000-4000-8000-000000000052',
  'd6700000-0000-4000-8000-000000000010','d6700000-0000-4000-8000-000000000020',
  date_trunc('day',transaction_timestamp()+interval '6 days')+interval '10 hours',
  date_trunc('day',transaction_timestamp()+interval '6 days')+interval '10 hours 30 minutes',
  date_trunc('day',transaction_timestamp()+interval '6 days')+interval '10 hours',
  date_trunc('day',transaction_timestamp()+interval '6 days')+interval '10 hours 30 minutes',
  0,30,0,0,'Sequence service one','Sequence departing',1000,1000,0,0,0,0,1000,0,1000,0,1000,'confirmed'),
 ('d6700000-0000-4000-8000-000000000063','d6700000-0000-4000-8000-000000000041',
  'd6700000-0000-4000-8000-000000000001',1,'d6700000-0000-4000-8000-000000000053',
  'd6700000-0000-4000-8000-000000000011','d6700000-0000-4000-8000-000000000021',
  date_trunc('day',transaction_timestamp()+interval '6 days')+interval '10 hours 30 minutes',
  date_trunc('day',transaction_timestamp()+interval '6 days')+interval '11 hours',
  date_trunc('day',transaction_timestamp()+interval '6 days')+interval '10 hours 30 minutes',
  date_trunc('day',transaction_timestamp()+interval '6 days')+interval '11 hours',
  0,30,0,0,'Sequence service two','Sequence anchor',2000,2000,0,0,0,0,2000,0,2000,0,2000,'confirmed');

-- Build legacy drift with the old transition trigger deliberately suspended,
-- then immediately restore the trigger. This remains transaction-local test
-- data and rehearses the 37200 deployment preflight without a provider call.
INSERT INTO public.bookings(
  id,salon_id,service_id,staff_id,client_name,client_phone,
  start_time_utc,end_time_utc,status,price_cents,schedule_model
) VALUES(
  'd6700000-0000-4000-8000-000000000043',
  'd6700000-0000-4000-8000-000000000001',
  'd6700000-0000-4000-8000-000000000010',
  'd6700000-0000-4000-8000-000000000025','Legacy drift guest','+16045550675',
  transaction_timestamp()+interval '21 days',
  transaction_timestamp()+interval '21 days 30 minutes',
  'confirmed',1000,'single'
);
ALTER TABLE public.staff DISABLE TRIGGER
  enforce_no_live_assignments_before_staff_deactivation;
UPDATE public.staff SET status='pending'
WHERE id='d6700000-0000-4000-8000-000000000025';
ALTER TABLE public.staff ENABLE TRIGGER
  enforce_no_live_assignments_before_staff_deactivation;

SET CONSTRAINTS check_booking_service_sequence_shape IMMEDIATE;
SET CONSTRAINTS check_booking_service_sequence_shape DEFERRED;

DO $sequence_offboarding$
DECLARE
  v_assignments jsonb:=
    '[{"booking_id":"d6700000-0000-4000-8000-000000000040","staff_id":"d6700000-0000-4000-8000-000000000022"},
      {"booking_id":"d6700000-0000-4000-8000-000000000041","staff_id":"d6700000-0000-4000-8000-000000000022"}]'::jsonb;
  v_result jsonb;
  v_recovery jsonb;
  v_too_many jsonb;
BEGIN
  BEGIN
    PERFORM 1
    FROM public.staff s
    WHERE (s.status IS DISTINCT FROM 'active' OR s.deleted_at IS NOT NULL)
      AND (
        EXISTS (
          SELECT 1 FROM public.bookings b
          WHERE b.staff_id=s.id AND b.deleted_at IS NULL
            AND b.status IN ('pending','confirmed','in_progress','waiting')
        )
        OR EXISTS (
          SELECT 1 FROM public.booking_service_segments seg
          WHERE seg.staff_id=s.id
            AND seg.reservation_status IN ('pending','confirmed','in_progress','waiting')
        )
      )
    ORDER BY s.id
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE='23514', MESSAGE='legacy non-active staff has live assignments';
    END IF;
    RAISE EXCEPTION 'legacy non-active assignment preflight missed drift';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'legacy non-active staff has live assignments' THEN RAISE; END IF;
  END;

  -- Tenant identity is immutable even without live bookings. Capability and
  -- schedule rows must never be stranded across salon boundaries.
  BEGIN
    UPDATE public.staff
    SET salon_id='d6700000-0000-4000-8000-000000000002'
    WHERE id='d6700000-0000-4000-8000-000000000024';
    RAISE EXCEPTION 'no-live staff salon move bypassed tenant invariant';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'staff salon_id is immutable' THEN RAISE; END IF;
  END;
  IF NOT EXISTS (
      SELECT 1 FROM public.staff
      WHERE id='d6700000-0000-4000-8000-000000000024'
        AND salon_id='d6700000-0000-4000-8000-000000000001'
    ) OR NOT EXISTS (
      SELECT 1 FROM public.staff_services
      WHERE staff_id='d6700000-0000-4000-8000-000000000024'
        AND service_id='d6700000-0000-4000-8000-000000000010'
    ) OR NOT EXISTS (
      SELECT 1 FROM public.staff_shifts
      WHERE staff_id='d6700000-0000-4000-8000-000000000024'
        AND salon_id='d6700000-0000-4000-8000-000000000001'
        AND day_of_week='mon'
    ) THEN
    RAISE EXCEPTION 'rejected no-live salon move changed tenant dependencies';
  END IF;

  -- Leave the target only on booking A's later segment. Direct status changes,
  -- soft deletion and hard deletion must all see that segment-only live use.
  UPDATE public.bookings SET status='cancelled'
  WHERE id='d6700000-0000-4000-8000-000000000041';
  BEGIN
    UPDATE public.staff SET status='pending'
    WHERE id='d6700000-0000-4000-8000-000000000020';
    RAISE EXCEPTION 'direct pending transition ignored segment assignment';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'staff with live bookings must be offboarded atomically' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.staff SET status='inactive'
    WHERE id='d6700000-0000-4000-8000-000000000020';
    RAISE EXCEPTION 'direct inactive transition ignored segment assignment';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'staff with live bookings must be offboarded atomically' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.staff SET deleted_at=transaction_timestamp()
    WHERE id='d6700000-0000-4000-8000-000000000020';
    RAISE EXCEPTION 'direct soft delete ignored segment assignment';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'staff with live bookings must be offboarded atomically' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.staff
    SET salon_id='d6700000-0000-4000-8000-000000000002'
    WHERE id='d6700000-0000-4000-8000-000000000020';
    RAISE EXCEPTION 'staff salon move ignored segment assignment';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'staff salon_id is immutable' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM public.staff
    WHERE id='d6700000-0000-4000-8000-000000000020';
    RAISE EXCEPTION 'direct delete ignored segment assignment';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM<>'staff with live bookings must be offboarded atomically' THEN RAISE; END IF;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM public.staff
    WHERE id='d6700000-0000-4000-8000-000000000020'
      AND salon_id='d6700000-0000-4000-8000-000000000001'
      AND status='active' AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'failed staff invariant attempt changed target row';
  END IF;
  UPDATE public.bookings SET status='confirmed'
  WHERE id='d6700000-0000-4000-8000-000000000041';

  v_result:=public.offboard_staff_with_durable_notifications(
    'd6700000-0000-4000-8000-000000000001',
    'd6700000-0000-4000-8000-000000000020',
    'd6700000-0000-4000-8000-000000000100',
    'd6700000-0000-4000-8000-000000000030','owner',v_assignments,
    false,true,false,20
  );
  IF v_result->>'code'<>'notification_channel_unavailable'
     OR EXISTS (SELECT 1 FROM public.staff_offboarding_receipts
       WHERE request_id='d6700000-0000-4000-8000-000000000100') THEN
    RAISE EXCEPTION 'disabled channel did not fail closed: %',v_result;
  END IF;

  v_result:=public.offboard_staff_with_durable_notifications(
    'd6700000-0000-4000-8000-000000000001',
    'd6700000-0000-4000-8000-000000000020',
    'd6700000-0000-4000-8000-000000000101',
    'd6700000-0000-4000-8000-000000000030','owner',
    '[{"booking_id":"d6700000-0000-4000-8000-000000000040","staff_id":"d6700000-0000-4000-8000-000000000023"},
      {"booking_id":"d6700000-0000-4000-8000-000000000041","staff_id":"d6700000-0000-4000-8000-000000000023"}]'::jsonb,
    true,false,false,20
  );
  IF v_result->>'code'<>'candidate_unavailable' THEN
    RAISE EXCEPTION 'incapable sequence candidate accepted: %',v_result;
  END IF;

  INSERT INTO public.bookings(
    id,salon_id,service_id,staff_id,client_name,client_phone,
    start_time_utc,end_time_utc,status,price_cents,schedule_model
  ) VALUES(
    'd6700000-0000-4000-8000-000000000042',
    'd6700000-0000-4000-8000-000000000001',
    'd6700000-0000-4000-8000-000000000011',
    'd6700000-0000-4000-8000-000000000022','Conflict guest','+16045550673',
    date_trunc('day',transaction_timestamp()+interval '5 days')+interval '10 hours 30 minutes',
    date_trunc('day',transaction_timestamp()+interval '5 days')+interval '11 hours',
    'confirmed',2000,'single'
  );
  v_result:=public.offboard_staff_with_durable_notifications(
    'd6700000-0000-4000-8000-000000000001',
    'd6700000-0000-4000-8000-000000000020',
    'd6700000-0000-4000-8000-000000000102',
    'd6700000-0000-4000-8000-000000000030','owner',v_assignments,
    true,false,false,20
  );
  IF v_result->>'code'<>'candidate_unavailable' THEN
    RAISE EXCEPTION 'conflicted sequence candidate accepted: %',v_result;
  END IF;
  UPDATE public.bookings SET status='cancelled'
  WHERE id='d6700000-0000-4000-8000-000000000042';

  v_result:=public.offboard_staff_with_durable_notifications(
    'd6700000-0000-4000-8000-000000000001',
    'd6700000-0000-4000-8000-000000000020',
    'd6700000-0000-4000-8000-000000000103',
    'd6700000-0000-4000-8000-000000000030','owner',v_assignments,
    true,false,false,20
  );
  IF v_result->>'code'<>'staff_offboarded'
     OR (v_result->>'reassigned_count')::integer<>2
     OR (v_result->>'notification_events_queued')::integer<>2
     OR (v_result->>'notification_deliveries_queued')::integer<>2
     OR (v_result->>'audit_events_recorded')::integer<>2 THEN
    RAISE EXCEPTION 'sequence offboarding result mismatch: %',v_result;
  END IF;

  IF (SELECT status FROM public.staff
      WHERE id='d6700000-0000-4000-8000-000000000020')<>'inactive'
     OR (SELECT staff_id FROM public.bookings
      WHERE id='d6700000-0000-4000-8000-000000000040')<>
        'd6700000-0000-4000-8000-000000000021'::uuid
     OR (SELECT staff_id FROM public.bookings
      WHERE id='d6700000-0000-4000-8000-000000000041')<>
        'd6700000-0000-4000-8000-000000000022'::uuid
     OR (SELECT count(*) FROM public.booking_service_segments
      WHERE booking_id IN (
        'd6700000-0000-4000-8000-000000000040',
        'd6700000-0000-4000-8000-000000000041'
      ) AND staff_id='d6700000-0000-4000-8000-000000000022')<>2
     OR EXISTS (SELECT 1 FROM public.booking_service_segments
      WHERE booking_id IN (
        'd6700000-0000-4000-8000-000000000040',
        'd6700000-0000-4000-8000-000000000041'
      ) AND staff_id='d6700000-0000-4000-8000-000000000020') THEN
    RAISE EXCEPTION 'sequence authoritative staff/parent mutation mismatch';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.bookings b
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      b.public_booking_pricing_snapshot->'segments'
    ) line(value)
    WHERE b.id IN (
      'd6700000-0000-4000-8000-000000000040',
      'd6700000-0000-4000-8000-000000000041'
    ) AND line.value->>'staff_id'='d6700000-0000-4000-8000-000000000020'
  ) OR EXISTS (
    SELECT 1 FROM public.bookings b
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      b.public_booking_pricing_snapshot#>'{reschedule_intent,lines}'
    ) line(value)
    WHERE b.id IN (
      'd6700000-0000-4000-8000-000000000040',
      'd6700000-0000-4000-8000-000000000041'
    ) AND line.value->>'staff_preference'='d6700000-0000-4000-8000-000000000020'
  ) OR EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.id='d6700000-0000-4000-8000-000000000040'
      AND b.public_booking_pricing_fingerprint=repeat('a',64)
  ) OR EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.id='d6700000-0000-4000-8000-000000000041'
      AND b.public_booking_pricing_fingerprint=repeat('c',64)
  ) THEN
    RAISE EXCEPTION 'sequence receipt/fingerprint retained departing staff';
  END IF;

  IF (SELECT count(*) FROM public.staff_action_notification_outbox
      WHERE salon_id='d6700000-0000-4000-8000-000000000001'
        AND event_type='staff_change')<>2
     OR EXISTS (SELECT 1 FROM public.staff_action_notification_outbox o
      WHERE o.salon_id='d6700000-0000-4000-8000-000000000001'
        AND o.event_type='staff_change'
        AND (
          o.material_snapshot->>'previous_staff_id'<>
            'd6700000-0000-4000-8000-000000000020'
          OR o.material_snapshot->>'staff_id'<>
            'd6700000-0000-4000-8000-000000000022'
          OR pg_catalog.jsonb_array_length(
            o.material_snapshot->'affected_segment_ids'
          )<>1
        ))
     OR (SELECT count(*) FROM public.booking_events
      WHERE salon_id='d6700000-0000-4000-8000-000000000001'
        AND staff_offboarding_request_id=
          'd6700000-0000-4000-8000-000000000103')<>2 THEN
    RAISE EXCEPTION 'sequence outbox/audit material mismatch';
  END IF;

  DELETE FROM public.booking_events
  WHERE booking_id='d6700000-0000-4000-8000-000000000040'
    AND staff_offboarding_request_id='d6700000-0000-4000-8000-000000000103';
  v_recovery:=public.recover_staff_offboarding_with_durable_notifications(
    'd6700000-0000-4000-8000-000000000001',
    'd6700000-0000-4000-8000-000000000020',
    'd6700000-0000-4000-8000-000000000103',
    'd6700000-0000-4000-8000-000000000030','owner'
  );
  IF v_recovery->>'code'<>'staff_offboarded'
     OR (v_recovery->>'idempotent')::boolean IS NOT TRUE
     OR (v_recovery->>'audit_events_recorded')::integer<>2
     OR (SELECT count(*) FROM public.booking_events
      WHERE staff_offboarding_request_id=
        'd6700000-0000-4000-8000-000000000103')<>2 THEN
    RAISE EXCEPTION 'sequence receipt/audit recovery mismatch: %',v_recovery;
  END IF;

  BEGIN
    INSERT INTO public.bookings(
      salon_id,service_id,staff_id,client_name,client_phone,
      start_time_utc,end_time_utc,status,price_cents,schedule_model
    ) VALUES(
      'd6700000-0000-4000-8000-000000000001',
      'd6700000-0000-4000-8000-000000000010',
      'd6700000-0000-4000-8000-000000000020','Late writer','+16045550674',
      transaction_timestamp()+interval '20 days',
      transaction_timestamp()+interval '20 days 30 minutes',
      'confirmed',1000,'single'
    );
    RAISE EXCEPTION 'inactive staff accepted a live booking';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'booking_id','d6700000-0000-4000-8000-000000000040',
    'staff_id','d6700000-0000-4000-8000-000000000022'
  )) INTO v_too_many FROM pg_catalog.generate_series(1,101);
  v_too_many:=public.offboard_staff_with_durable_notifications(
    'd6700000-0000-4000-8000-000000000001',
    'd6700000-0000-4000-8000-000000000020',
    'd6700000-0000-4000-8000-000000000104',
    'd6700000-0000-4000-8000-000000000030','owner',v_too_many,
    false,false,false,20
  );
  IF v_too_many->>'code'<>'too_many_bookings'
     OR (v_too_many->>'limit')::integer<>100
     OR (v_too_many->>'submitted_count')::integer<>101 THEN
    RAISE EXCEPTION 'explicit >100 behavior mismatch: %',v_too_many;
  END IF;
END;
$sequence_offboarding$;

ROLLBACK;

SELECT 'PASS sequence-aware staff offboarding, capability/conflict, recovery and active-write guard' AS result;
