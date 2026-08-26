\set ON_ERROR_STOP on

BEGIN;
INSERT INTO public.service_categories(slug, name_en, name_vi)
VALUES ('sequence-rollback-qa', 'Sequence rollback QA', 'Sequence rollback QA');
INSERT INTO public.salons(id, slug, name, phone, timezone, is_beta)
VALUES (
  '18003600-0000-4000-8000-000000009001', 'sequence-rollback-qa',
  'Sequence rollback QA', '+16045559001', 'UTC', true
);
INSERT INTO public.services(
  id, salon_id, name, price_cents, duration_minutes, buffer_minutes,
  prep_minutes, category
) VALUES (
  '18003600-0000-4000-8000-000000009002',
  '18003600-0000-4000-8000-000000009001',
  'Sequence rollback service', 1000, 30, 5, 5, 'sequence-rollback-qa'
);
INSERT INTO public.staff(id, salon_id, name, status) VALUES (
  '18003600-0000-4000-8000-000000009003',
  '18003600-0000-4000-8000-000000009001',
  'Sequence rollback staff', 'active'
);
INSERT INTO public.bookings(
  id, salon_id, service_id, staff_id, client_name, client_phone,
  start_time_utc, end_time_utc, status, source,
  price_cents, original_price_cents, subtotal_cents, tax_amount_cents,
  schedule_model, sequence_version
) VALUES (
  '18003600-0000-4000-8000-000000009004',
  '18003600-0000-4000-8000-000000009001',
  '18003600-0000-4000-8000-000000009002',
  '18003600-0000-4000-8000-000000009003',
  'Sequence rollback customer', '16045559004',
  transaction_timestamp() + interval '10 days',
  transaction_timestamp() + interval '10 days 30 minutes',
  'confirmed', 'appointment', 1000, 1000, 1000, 0,
  'segments_v1', 1
);
INSERT INTO public.booking_service_segments(
  id, booking_id, salon_id, position, line_id, service_id, staff_id,
  customer_start_utc, customer_end_utc, occupied_start_utc, occupied_end_utc,
  prep_minutes, service_duration_minutes, sequential_addon_minutes,
  trailing_buffer_minutes, service_name, staff_name,
  original_service_price_cents, service_pre_voucher_cents,
  addon_pre_voucher_cents, promo_discount_cents, email_discount_cents,
  voucher_discount_cents, service_price_cents, addon_price_cents,
  subtotal_cents, tax_cents, total_cents, reservation_status
) VALUES (
  '18003600-0000-4000-8000-000000009005',
  '18003600-0000-4000-8000-000000009004',
  '18003600-0000-4000-8000-000000009001', 0,
  '18003600-0000-4000-8000-000000009006',
  '18003600-0000-4000-8000-000000009002',
  '18003600-0000-4000-8000-000000009003',
  transaction_timestamp() + interval '10 days',
  transaction_timestamp() + interval '10 days 30 minutes',
  transaction_timestamp() + interval '9 days 23 hours 55 minutes',
  transaction_timestamp() + interval '10 days 30 minutes',
  5, 30, 0, 0, 'Sequence rollback service', 'Sequence rollback staff',
  1000, 1000, 0, 0, 0, 0, 1000, 0, 1000, 0, 1000, 'confirmed'
);
SET CONSTRAINTS ALL IMMEDIATE;
ROLLBACK;

DO $sequence_rollback_verify$
BEGIN
  IF EXISTS (SELECT 1 FROM public.bookings
      WHERE id = '18003600-0000-4000-8000-000000009004')
     OR EXISTS (SELECT 1 FROM public.booking_service_segments
      WHERE id = '18003600-0000-4000-8000-000000009005')
     OR EXISTS (SELECT 1 FROM public.salons
      WHERE id = '18003600-0000-4000-8000-000000009001') THEN
    RAISE EXCEPTION 'sequence rollback left fixture/business rows';
  END IF;
END;
$sequence_rollback_verify$;

SELECT 'booking_service_sequence_rollback_pass' AS result;
