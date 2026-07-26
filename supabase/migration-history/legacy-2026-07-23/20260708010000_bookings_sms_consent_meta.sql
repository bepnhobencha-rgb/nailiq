-- Twilio A2P 10DLC / TCPA evidence.
--
-- `sms_consent_at` (20260610150000) stores only *when* the customer ticked the
-- box. A carrier complaint or TCPA dispute asks for more: from what address,
-- on what device, and — critically — the exact disclosure wording the customer
-- was shown, because that wording changes over time. Keep all of it next to
-- the timestamp so a consent record is self-contained.
--
-- Shape of sms_consent_meta:
--   { "ip": "1.2.3.4", "userAgent": "...", "version": "2026-07-08.v1",
--     "text": "<disclosure exactly as displayed>", "lang": "en" | "vi",
--     "source": "public_booking" | "group_booking" }
alter table public.bookings
  add column if not exists sms_consent_meta jsonb;

-- A TCPA/carrier audit asks "which bookings carry consent" — sms_consent_at is
-- the filter. Partial: consented rows are the minority and the only ones read.
create index if not exists bookings_sms_consent_at_idx
  on public.bookings (sms_consent_at)
  where sms_consent_at is not null;
