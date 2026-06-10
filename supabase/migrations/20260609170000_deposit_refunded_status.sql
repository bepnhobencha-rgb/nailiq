-- Allow 'refunded' deposit_status so a desk-cancel can refund the Square deposit
-- (mutually-agreed cancellation) vs keep it (forfeit on no-show / late cancel).
alter table public.bookings drop constraint if exists bookings_deposit_status_check;
alter table public.bookings add constraint bookings_deposit_status_check
  check (deposit_status = any (array['not_required','required','paid','waived','refunded']));
