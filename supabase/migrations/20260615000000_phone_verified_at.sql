-- "Verify once, trust": remember when a phone last passed OTP so returning
-- customers aren't re-challenged on every booking. Set on OTP-verified bookings;
-- read by determine_booking_verification to skip OTP for an already-verified,
-- clean, non-dormant phone. Card-on-file still protects money independently.
alter table public.client_profiles
  add column if not exists phone_verified_at timestamptz;

comment on column public.client_profiles.phone_verified_at is
  'Last time this phone successfully passed OTP. Used by determine_booking_verification to skip OTP for a previously-verified phone (unless it has a no-show or the verification is >12 months stale).';
