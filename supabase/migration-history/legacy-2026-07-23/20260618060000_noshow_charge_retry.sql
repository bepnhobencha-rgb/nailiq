-- Auto-retry bookkeeping for failed no-show fee charges.
-- The retry cron charges a failed card at most once/day for 3 days, then stops
-- (leaving it for the desk). These columns pace + cap those attempts.
alter table bookings
  add column if not exists noshow_charge_attempts integer not null default 0,
  add column if not exists noshow_last_charge_attempt_at timestamptz;

comment on column bookings.noshow_charge_attempts is
  'Number of auto-retry charge attempts made by the noshow-charge-retry cron (capped at 3).';
comment on column bookings.noshow_last_charge_attempt_at is
  'Timestamp of the last auto-retry charge attempt — enforces once-per-day pacing.';
