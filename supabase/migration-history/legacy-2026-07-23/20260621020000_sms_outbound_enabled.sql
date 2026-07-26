-- Replace the A2P-only gate with a clearer operational flag.
-- Default TRUE: non-US salons work without any setup.
-- US salons pending Twilio A2P 10DLC registration should set this FALSE
-- in Admin Settings (Kênh nhắn tin) until carriers approve their number.
ALTER TABLE salons
  ADD COLUMN IF NOT EXISTS sms_outbound_enabled BOOLEAN NOT NULL DEFAULT TRUE;
