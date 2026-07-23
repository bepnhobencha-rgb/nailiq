-- Tracks whether this salon has completed Twilio A2P 10DLC registration.
-- When false (default), automated SMS (non-OTP) is unreliable for US numbers
-- and email is used as the primary customer channel.
ALTER TABLE salons ADD COLUMN IF NOT EXISTS sms_a2p_registered BOOLEAN NOT NULL DEFAULT FALSE;

-- Controls how automated communications reach customers.
--   smart       = email when available; SMS when A2P registered + no email; skip both if neither works
--   sms_only    = SMS only (requires A2P registered to be effective)
--   email_only  = email only (skips SMS entirely)
--   sms_and_email = both channels sent whenever available (post-A2P parallel)
ALTER TABLE salons ADD COLUMN IF NOT EXISTS customer_channel TEXT NOT NULL DEFAULT 'smart'
  CONSTRAINT salons_customer_channel_check
    CHECK (customer_channel IN ('smart', 'sms_only', 'email_only', 'sms_and_email'));
