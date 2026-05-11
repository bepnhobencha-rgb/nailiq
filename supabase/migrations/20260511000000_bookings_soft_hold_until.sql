-- Soft hold for walk-ins that step out (bathroom, car, food, etc).
--
-- The receptionist marks `soft_hold_until = now() + 10 minutes` to
-- preserve the customer's queue position without requiring them to
-- be physically present. The booking remains in `status='waiting'`
-- and renders a countdown on the queue card. After expiry the card
-- returns to its normal waiting treatment and the receptionist is
-- notified ("Mai's hold expired").
--
-- Nullable so existing rows are "no hold" and only flagged customers
-- carry a held-until timestamp.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS soft_hold_until timestamptz NULL;

COMMENT ON COLUMN public.bookings.soft_hold_until IS
  'Walk-in soft hold expiry (UTC). When > now() the customer is in '
  '"stepped out" state and their queue position is preserved without '
  'requiring physical presence. NULL = no hold (default).';

-- Partial index — only held rows. Lets the realtime tick efficiently
-- find rows whose hold has expired without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_bookings_soft_hold_until
  ON public.bookings (soft_hold_until)
  WHERE soft_hold_until IS NOT NULL;

-- ──────────────────────────────────────────────────────────────────
-- booking_events — relax booking_id so we can log salon-scoped
-- operational events (rush_hour_started / rush_hour_ended) that
-- aren't tied to a single booking.

ALTER TABLE public.booking_events
  ALTER COLUMN booking_id DROP NOT NULL;

COMMENT ON COLUMN public.booking_events.booking_id IS
  'Booking the event pertains to. NULL for salon-scoped events such '
  'as rush_hour_started / rush_hour_ended that span the whole desk.';
