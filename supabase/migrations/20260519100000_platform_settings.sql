-- Singleton platform-wide settings row (id = 'platform').
-- Service role only — RLS prevents any anon / auth access.

CREATE TABLE IF NOT EXISTS platform_settings (
  id                       text        PRIMARY KEY DEFAULT 'platform',
  twilio_account_sid       text,
  twilio_auth_token        text,
  twilio_verify_service_sid text,
  resend_api_key           text,
  resend_from              text,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
-- No public policies → service role only.

-- Seed the singleton row so UPDATE always hits it.
INSERT INTO platform_settings (id) VALUES ('platform')
ON CONFLICT (id) DO NOTHING;
