-- B-03: per-staff visibility status. Public booking + walk-in assign filter
-- on status='active'; dashboard shows all rows with a badge for non-active.
--
-- Existing rows pick up the default via NOT NULL DEFAULT 'active', so no
-- backfill is needed and no public booking flow regresses on day one.

ALTER TABLE public.staff
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'pending', 'inactive'));

COMMENT ON COLUMN public.staff.status IS
  'active=visible to customers; pending=owner-added but not yet verified; inactive=on leave / disabled.';

-- Helpful for the public booking staff query which now always includes
-- status='active'. Partial index keeps it tiny (active is the common case).
CREATE INDEX IF NOT EXISTS staff_active_by_salon_idx
  ON public.staff (salon_id)
  WHERE status = 'active';
