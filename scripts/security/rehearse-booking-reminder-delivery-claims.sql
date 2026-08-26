\set ON_ERROR_STOP on

BEGIN;
SET LOCAL ROLE service_role;

INSERT INTO public.service_categories(slug,name_en,name_vi)
VALUES ('reminder-claim-qa','Reminder claim QA','Reminder claim QA')
ON CONFLICT (slug) DO NOTHING;
INSERT INTO public.salons(id,slug,name,phone,timezone,is_beta)
VALUES
  ('18000000-0000-4000-8000-000000000001','reminder-claim-qa-a','Reminder Claim QA A','+16045551801','UTC',true),
  ('18000000-0000-4000-8000-000000000002','reminder-claim-qa-b','Reminder Claim QA B','+16045551802','UTC',true);
INSERT INTO public.services(id,salon_id,name,price_cents,duration_minutes,category)
VALUES ('18000000-0000-4000-8000-000000000003','18000000-0000-4000-8000-000000000001','Reminder service',2500,30,'reminder-claim-qa');
INSERT INTO public.staff(id,salon_id,name,status)
VALUES ('18000000-0000-4000-8000-000000000004','18000000-0000-4000-8000-000000000001','Reminder staff','active');
INSERT INTO public.bookings(
  id,salon_id,service_id,staff_id,client_name,client_phone,client_email,
  start_time_utc,end_time_utc,status,price_cents
) VALUES (
  '18000000-0000-4000-8000-000000000010',
  '18000000-0000-4000-8000-000000000001',
  '18000000-0000-4000-8000-000000000003',
  '18000000-0000-4000-8000-000000000004',
  'Reminder Fixture','+16045551810','reminder@nailiq.invalid',
  '2026-08-25T18:00:00Z','2026-08-25T18:30:00Z','confirmed',2500
);

DO $behavior$
DECLARE
  v_salon uuid := '18000000-0000-4000-8000-000000000001';
  v_booking uuid := '18000000-0000-4000-8000-000000000010';
  v_start timestamptz := '2026-08-25T18:00:00Z';
  v_claim jsonb;
  v_result jsonb;
  v_claim_id uuid;
BEGIN
  v_claim := public.claim_booking_reminder_delivery(
    v_salon,v_booking,v_start,'24h','email'
  );
  IF v_claim->>'code' <> 'claimed' OR v_claim->>'claimed' <> 'true' THEN
    RAISE EXCEPTION 'first reminder claim failed: %', v_claim;
  END IF;
  v_claim_id := (v_claim->>'claim_id')::uuid;

  v_result := public.claim_booking_reminder_delivery(
    v_salon,v_booking,v_start,'24h','email'
  );
  IF v_result->>'code' <> 'duplicate_suppressed'
     OR v_result->>'status' <> 'sending' THEN
    RAISE EXCEPTION 'in-flight duplicate was not suppressed: %', v_result;
  END IF;

  v_result := public.complete_booking_reminder_delivery(
    v_claim_id,'failed',null,'delivery_preflight_or_rejection_failed'
  );
  IF v_result->>'code' <> 'completed' THEN
    RAISE EXCEPTION 'known failure completion failed: %', v_result;
  END IF;

  v_result := public.claim_booking_reminder_delivery(
    v_salon,v_booking,v_start,'24h','email'
  );
  IF v_result->>'code' <> 'claimed'
     OR v_result->>'attempt_count' <> '2' THEN
    RAISE EXCEPTION 'known failure retry was not leased: %', v_result;
  END IF;
  v_claim_id := (v_result->>'claim_id')::uuid;

  v_result := public.complete_booking_reminder_delivery(
    v_claim_id,'sent','email-provider-receipt-qa',null
  );
  IF v_result->>'status' <> 'sent' THEN
    RAISE EXCEPTION 'accepted reminder completion failed: %', v_result;
  END IF;

  v_result := public.claim_booking_reminder_delivery(
    v_salon,v_booking,v_start,'24h','sms'
  );
  v_claim_id := (v_result->>'claim_id')::uuid;
  UPDATE public.booking_reminder_delivery_claims
  SET claimed_at=transaction_timestamp()-interval '16 minutes',
      lease_expires_at=transaction_timestamp()-interval '1 minute'
  WHERE id=v_claim_id;
  v_result := public.claim_booking_reminder_delivery(
    v_salon,v_booking,v_start,'24h','sms'
  );
  IF v_result->>'code' <> 'duplicate_suppressed'
     OR v_result->>'status' <> 'unknown' THEN
    RAISE EXCEPTION 'stale provider ambiguity was retried: %', v_result;
  END IF;

  UPDATE public.bookings
  SET start_time_utc='2026-08-26T18:00:00Z',
      end_time_utc='2026-08-26T18:30:00Z'
  WHERE id=v_booking;
  v_result := public.claim_booking_reminder_delivery(
    v_salon,v_booking,'2026-08-26T18:00:00Z','24h','email'
  );
  IF v_result->>'code' <> 'claimed' THEN
    RAISE EXCEPTION 'rescheduled occurrence could not claim: %', v_result;
  END IF;

  v_result := public.claim_booking_reminder_delivery(
    '18000000-0000-4000-8000-000000000002',v_booking,
    '2026-08-26T18:00:00Z','24h','email'
  );
  IF v_result->>'code' <> 'invalid_claim' THEN
    RAISE EXCEPTION 'cross-salon reminder claim accepted: %', v_result;
  END IF;
END;
$behavior$;

ROLLBACK;

DO $cleanup$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.salons
    WHERE id IN (
      '18000000-0000-4000-8000-000000000001',
      '18000000-0000-4000-8000-000000000002'
    )
  ) OR EXISTS (
    SELECT 1 FROM public.booking_reminder_delivery_claims
    WHERE booking_id='18000000-0000-4000-8000-000000000010'
  ) THEN
    RAISE EXCEPTION 'reminder claim rehearsal left fixture rows';
  END IF;
END;
$cleanup$;

SELECT 'booking_reminder_delivery_claim_rehearsal_pass' AS result;
