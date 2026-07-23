-- "Pay-deposit-to-confirm" gate for desk/phone bookings.
--
-- deposit_hold = this booking's slot is only held until the deposit is paid; if
-- it stays unpaid past the grace window the release-pending cron cancels it (so a
-- phone customer who never pays doesn't sit on a slot). Cleared when the deposit
-- is paid (reconcile) — the booking is then a firm confirmed appointment.
--
-- deposit_requested_at = when the deposit link was created; the grace window is
-- measured from THIS (not created_at — an existing booking can get a deposit
-- request long after it was made).

alter table public.bookings
  add column if not exists deposit_hold boolean not null default false,
  add column if not exists deposit_requested_at timestamptz;

comment on column public.bookings.deposit_hold is 'Slot held only until the deposit is paid; release-pending cron cancels it if unpaid past the grace window. Cleared on payment.';
comment on column public.bookings.deposit_requested_at is 'When the deposit pay-link was created — start of the pay-or-release grace window.';

-- Partial index for the cron sweep (only the few held+unpaid rows).
create index if not exists idx_bookings_deposit_hold_pending
  on public.bookings (deposit_requested_at)
  where deposit_hold = true and deposit_status = 'required';
