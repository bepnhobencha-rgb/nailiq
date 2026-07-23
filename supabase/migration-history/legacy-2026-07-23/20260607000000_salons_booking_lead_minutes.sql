-- Minimum advance notice (minutes) before a same-day slot becomes bookable.
-- Replaces the hardcoded 15-min BOOKING_BUFFER. Default 15 preserves behavior.
ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS booking_lead_minutes integer NOT NULL DEFAULT 15
    CHECK (booking_lead_minutes >= 0 AND booking_lead_minutes <= 1440);

COMMENT ON COLUMN public.salons.booking_lead_minutes IS
  'Minimum lead time (minutes) for same-day online bookings — slots starting sooner than now()+this are hidden. Default 15.';
