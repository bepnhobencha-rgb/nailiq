-- Full-auto waitlist backfill — schema.
-- When a booking is cancelled/no-showed, the freed slot is a CONCRETE
-- {staff, start, end} (the flip already matches the same service_id, so the
-- freed window fits the waitlisted service exactly). Capture it on the entry
-- so a claim can auto-create the real booking with zero staff input. All
-- nullable — only set when a concrete slot was freed; null = manual flow.

ALTER TABLE public.booking_waitlist_entries
  ADD COLUMN IF NOT EXISTS offered_staff_id  uuid REFERENCES public.staff (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS offered_start_utc timestamptz,
  ADD COLUMN IF NOT EXISTS offered_end_utc   timestamptz,
  -- The booking auto-created when the customer claimed (auto-book path only).
  ADD COLUMN IF NOT EXISTS booked_booking_id uuid REFERENCES public.bookings (id) ON DELETE SET NULL;
