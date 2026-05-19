-- Per-salon no-show protection settings

ALTER TABLE salons
  ADD COLUMN IF NOT EXISTS reminders_enabled        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reminder_24h_enabled     boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS reminder_3h_enabled      boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS deposit_high_value_cents integer NOT NULL DEFAULT 10000;

COMMENT ON COLUMN salons.reminders_enabled        IS 'Master switch for automated reminder emails.';
COMMENT ON COLUMN salons.reminder_24h_enabled     IS 'Send reminder 24 h before appointment.';
COMMENT ON COLUMN salons.reminder_3h_enabled      IS 'Send reminder 3 h before appointment.';
COMMENT ON COLUMN salons.deposit_high_value_cents IS 'Service price >= this triggers a deposit. Default $100.';
