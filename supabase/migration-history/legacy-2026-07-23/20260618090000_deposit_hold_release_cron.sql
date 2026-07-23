-- P0 fix for the no-show auto-escalation: the held deposit (pending) slot was
-- being cancelled by the generic 15-min "release unverified pending" pg_cron
-- BEFORE the deposit grace window — so a customer who paid the deposit link at
-- minute 18-25 lost a slot already cancelled (refund owed).
--
-- (1) Exclude deposit-hold bookings from the generic 15-min sweep (job 6).
-- (2) Add a dedicated release that cancels deposit-hold bookings only AFTER the
--     per-salon grace + a 10-min buffer (the buffer guarantees square-sync's
--     reconcileDeposits, every 5 min, has flipped a paid hold to 'paid' first —
--     so a PAID slot is never cancelled).
--
-- Applied to prod via cron.alter_job(6) + cron.schedule('release-deposit-hold').
-- This migration is the source-of-record; re-running is idempotent.

select cron.alter_job(
  job_id := 6,
  command := $$
    UPDATE public.bookings
    SET status = 'cancelled'
    WHERE status = 'pending'
      AND verification_method IS NULL
      AND deposit_hold IS NOT TRUE
      AND created_at < NOW() - INTERVAL '15 minutes';
  $$
);

select cron.schedule(
  'release-deposit-hold',
  '*/5 * * * *',
  $$
    UPDATE public.bookings b
    SET status = 'cancelled', deposit_hold = false
    FROM public.salons s
    WHERE b.salon_id = s.id
      AND b.deposit_hold = true
      AND b.deposit_status = 'required'
      AND b.status = 'pending'
      AND b.deposit_requested_at IS NOT NULL
      AND b.deposit_requested_at
          < NOW() - ((COALESCE(s.deposit_hold_grace_minutes, 30) + 10) || ' minutes')::interval;
  $$
);
