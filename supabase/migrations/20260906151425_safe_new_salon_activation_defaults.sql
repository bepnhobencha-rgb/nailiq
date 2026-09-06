-- New salons are private workspaces until an Owner completes setup and
-- explicitly enables each customer-facing channel. This changes defaults for
-- future INSERTs only; existing salons and their live settings are untouched.
--
-- Rollback: restore the previous defaults (email/SMS outbound, email links,
-- 24h/3h reminder switches, and win-back = true). No row data is rewritten by
-- either direction.

ALTER TABLE public.salons
  ALTER COLUMN profile_complete SET DEFAULT false,
  ALTER COLUMN sms_outbound_enabled SET DEFAULT false,
  ALTER COLUMN email_outbound_enabled SET DEFAULT false,
  ALTER COLUMN email_links_enabled SET DEFAULT false,
  ALTER COLUMN reminders_enabled SET DEFAULT false,
  ALTER COLUMN reminder_24h_enabled SET DEFAULT false,
  ALTER COLUMN reminder_3h_enabled SET DEFAULT false,
  ALTER COLUMN sms_reminders_enabled SET DEFAULT false,
  ALTER COLUMN voice_ai_enabled SET DEFAULT false,
  ALTER COLUMN noshow_protection_enabled SET DEFAULT false,
  ALTER COLUMN winback_enabled SET DEFAULT false,
  ALTER COLUMN payment_provider DROP DEFAULT;

COMMENT ON COLUMN public.salons.profile_complete IS
  'Public booking activation gate. New salons remain false until setup readiness is complete.';
COMMENT ON COLUMN public.salons.sms_outbound_enabled IS
  'Owner-controlled customer SMS dispatch gate; defaults OFF for new salons.';
COMMENT ON COLUMN public.salons.email_outbound_enabled IS
  'Owner-controlled customer email dispatch gate; defaults OFF for new salons.';
