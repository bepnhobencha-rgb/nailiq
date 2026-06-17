-- Per-salon email outbound gate. Default TRUE — all existing salons keep sending email.
-- Set to FALSE for salons that want SMS-only (e.g. Canadian salons where customers
-- don't provide email addresses). Gates: reminders, booking confirmations,
-- staff-action notifications, and all AI agent emails (win-back/rebook/VIP care).
ALTER TABLE salons
  ADD COLUMN IF NOT EXISTS email_outbound_enabled BOOLEAN NOT NULL DEFAULT TRUE;
