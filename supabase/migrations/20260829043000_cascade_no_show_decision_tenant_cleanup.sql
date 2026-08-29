-- A no-show decision is owned by its salon and booking. Keep the receipt for
-- the lifetime of those parent rows, but do not prevent an explicitly
-- authorized booking/customer or tenant deletion (including marker-scoped E2E
-- cleanup) after the parent itself is removed.

ALTER TABLE public.booking_no_show_decisions
  DROP CONSTRAINT IF EXISTS booking_no_show_decisions_salon_id_fkey,
  ADD CONSTRAINT booking_no_show_decisions_salon_id_fkey
    FOREIGN KEY (salon_id)
    REFERENCES public.salons(id)
    ON DELETE CASCADE;

ALTER TABLE public.booking_no_show_decisions
  DROP CONSTRAINT IF EXISTS booking_no_show_decisions_booking_id_fkey,
  ADD CONSTRAINT booking_no_show_decisions_booking_id_fkey
    FOREIGN KEY (booking_id)
    REFERENCES public.bookings(id)
    ON DELETE CASCADE;
