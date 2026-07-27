-- Controlled after-hours desk bookings.
--
-- Public/voice/AI booking continues to use create_public_booking and therefore
-- remains constrained by normal opening hours. These columns only record an
-- authenticated Owner/Admin exception created by the private dashboard server
-- action after explicit staff-consent confirmation.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS after_hours_minutes smallint,
  ADD COLUMN IF NOT EXISTS after_hours_approved_by uuid
    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS after_hours_staff_consent boolean
    NOT NULL DEFAULT false;

ALTER TABLE public.bookings
  DROP CONSTRAINT IF EXISTS bookings_after_hours_override_check;

ALTER TABLE public.bookings
  ADD CONSTRAINT bookings_after_hours_override_check CHECK (
    (
      after_hours_minutes IS NULL
      AND after_hours_approved_by IS NULL
      AND after_hours_staff_consent IS FALSE
    )
    OR
    (
      after_hours_minutes BETWEEN 1 AND 120
      AND after_hours_approved_by IS NOT NULL
      AND after_hours_staff_consent IS TRUE
      AND booking_channel = 'desk'
    )
  );

COMMENT ON COLUMN public.bookings.after_hours_minutes IS
  'Customer-facing service minutes beyond salon close for a controlled Owner/Admin desk override (1-120).';
COMMENT ON COLUMN public.bookings.after_hours_approved_by IS
  'Authenticated Owner/Admin who approved the controlled after-hours booking.';
COMMENT ON COLUMN public.bookings.after_hours_staff_consent IS
  'Explicit confirmation that the selected staff member agreed to work after close.';
