-- Email OTP fallback codes.
--
-- The booking phone-OTP is delivered by Twilio Verify (SMS). US carriers filter
-- link/code SMS from unregistered A2P 10DLC numbers, so a customer can be unable
-- to receive the code and gets stuck. This table backs a SELF-CONTAINED email
-- fallback: we generate our own 6-digit code, store only its HMAC, email it via
-- Resend, and on success mint the SAME phone_otp_sessions row the SMS path does
-- (keyed by phone + salon) — so nothing downstream changes.
--
-- Service-role only (RLS on, no public policies) — anon can never read codes.

create table if not exists email_otp_codes (
  id          uuid        primary key default gen_random_uuid(),
  salon_id    uuid        not null references salons(id) on delete cascade,
  phone       text        not null,        -- booking phone digits, mints the session
  email       text        not null,
  code_hash   text        not null,        -- HMAC-SHA256(code, server secret) — never plaintext
  attempts    int         not null default 0,
  expires_at  timestamptz not null default (now() + interval '10 minutes'),
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

alter table email_otp_codes enable row level security;
-- No public policies → anon cannot read or write; service role bypasses RLS.

-- Lookup the active code for a (salon, phone, email); sweep expiries; rate-limit
-- by counting recent rows per (salon, phone).
create index if not exists email_otp_codes_lookup_idx
  on email_otp_codes (salon_id, phone, email, consumed_at);
create index if not exists email_otp_codes_expires_idx
  on email_otp_codes (expires_at);
create index if not exists email_otp_codes_ratelimit_idx
  on email_otp_codes (salon_id, phone, created_at);
