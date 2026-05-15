-- Salon-level toggle: when a walk-in customer is added and a staff
-- member is free now, should the booking auto-confirm onto the
-- timeline (current behavior) or always land in the queue first
-- for receptionist review?
--
-- DEFAULT TRUE preserves the existing assign-immediately path so no
-- migration data fix-up is needed.

ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS walkin_auto_assign boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.salons.walkin_auto_assign IS
  'TRUE = receptionist''s "Assign immediately" path is enabled. When a '
  'walk-in is added and the chosen staff is isAvailableNow, the '
  'booking is created confirmed at start_time = now(). FALSE = every '
  'walk-in lands in status=waiting first; the receptionist must '
  'manually assign from the queue panel even when staff is free.';
