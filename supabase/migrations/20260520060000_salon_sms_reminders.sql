-- Per-salon SMS reminder toggle + platform Twilio phone number for outbound SMS.

ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS sms_reminders_enabled bool NOT NULL DEFAULT false;

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS twilio_phone_number text;
