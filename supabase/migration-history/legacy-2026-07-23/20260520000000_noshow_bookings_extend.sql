-- No-Show Protection: extend bookings + client_profiles

-- Reminder tracking columns
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS reminder_24h_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_3h_sent_at  timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_at         timestamptz;

-- Reschedule audit trail (keep original time when rescheduled)
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS rescheduled_from_time_utc timestamptz,
  ADD COLUMN IF NOT EXISTS rescheduled_at            timestamptz,
  ADD COLUMN IF NOT EXISTS rescheduled_by            text;

-- Deposit state machine
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS deposit_required     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deposit_amount_cents integer,
  ADD COLUMN IF NOT EXISTS deposit_reason       text,
  ADD COLUMN IF NOT EXISTS deposit_status       text    NOT NULL DEFAULT 'not_required'
    CONSTRAINT bookings_deposit_status_check
    CHECK (deposit_status IN ('not_required','required','paid','waived'));

-- AI no-show risk score (0–100; NULL = not yet scored)
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS no_show_risk_score integer
    CONSTRAINT bookings_risk_score_range CHECK (no_show_risk_score BETWEEN 0 AND 100);

-- Client no-show history + VIP flag (for deposit rule engine)
ALTER TABLE client_profiles
  ADD COLUMN IF NOT EXISTS no_show_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_vip        boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN bookings.deposit_status IS 'not_required | required | paid | waived';
COMMENT ON COLUMN bookings.no_show_risk_score IS 'AI-computed 0–100 risk. NULL = not yet scored.';
COMMENT ON COLUMN client_profiles.no_show_count IS 'Incremented when booking for this phone is marked no_show.';
COMMENT ON COLUMN client_profiles.is_vip IS 'VIP customers are exempt from deposit requirements.';
