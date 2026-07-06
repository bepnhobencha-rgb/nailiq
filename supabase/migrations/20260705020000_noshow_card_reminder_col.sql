-- Phase 1 of graceful no-show card recovery: a follow-up nudge for future
-- bookings that were asked for a card-on-file but never left one.
--
-- `noshow_card_reminder_sent_at` marks that the recovery nudge has been sent
-- (once-only). The nudge cron (/api/cron/noshow-card-nudge, flag-gated OFF)
-- claims rows where this is NULL.
alter table public.bookings
  add column if not exists noshow_card_reminder_sent_at timestamptz;

-- GRANDFATHER: stamp every EXISTING card-required booking as already nudged so
-- the new cron can NEVER touch the current backlog (incl. the confirmed future
-- appointments customers already made). Only bookings created AFTER this
-- migration get a NULL marker and become eligible. Nothing is cancelled — ever.
update public.bookings
   set noshow_card_reminder_sent_at = now()
 where noshow_card_reminder_sent_at is null
   and noshow_card_required is true;
