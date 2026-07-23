-- Global platform-wide flags. SuperAdmin-only writes; the value of
-- each flag is consulted by various server-side gates (demo OTP path,
-- Stripe billing init, SMS/email transports, registration form).
--
-- Per-salon feature_flags stay on `salons.feature_flags jsonb` —
-- this table is for switches that affect every salon at once.

CREATE TABLE IF NOT EXISTS public.platform_flags (
  key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  description text,
  updated_at timestamptz DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.platform_flags IS
  'Global feature switches consulted by server-side gates. SuperAdmin-only. '
  'Per-salon overrides live on salons.feature_flags (jsonb).';

INSERT INTO public.platform_flags (key, enabled, description) VALUES
  ('demo_otp_enabled',          false, 'Allow demo OTP bypass for testing. DANGER on prod.'),
  ('stripe_billing_enabled',    false, 'Enable Stripe billing globally.'),
  ('sms_enabled',               false, 'Enable SMS transport (Twilio).'),
  ('email_enabled',             false, 'Enable email transport (Resend).'),
  ('new_salon_registration',    true,  'Allow new salon registrations.')
ON CONFLICT (key) DO NOTHING;

-- RLS: deny everything by default; service-role bypasses anyway and
-- the SuperAdmin actions go through service-role.
ALTER TABLE public.platform_flags ENABLE ROW LEVEL SECURITY;
