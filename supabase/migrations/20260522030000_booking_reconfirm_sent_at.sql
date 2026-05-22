-- Track whether the 24h auto re-confirmation SMS has been sent for a booking.
alter table public.bookings
  add column if not exists reconfirm_sent_at timestamptz;

comment on column public.bookings.reconfirm_sent_at is
  'Timestamp when the 24h auto re-confirmation SMS was sent. NULL = not yet sent.';
