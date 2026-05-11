-- Service categories on `services` (PR follow-up to the menu rework).
-- Customers see services grouped by category on the public booking page;
-- owners pick the category in the setup wizard. `other` is the default
-- so a salon that hasn't touched setup gets a single flat group
-- (backward compatible — public UI renders a flat list when every row
-- is `other`).

ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS category text
    NOT NULL DEFAULT 'other'
    CHECK (category IN (
      'manicure','pedicure','acrylic','gel','dip','waxing','other'
    ));

-- Best-effort backfill for legacy rows from name pattern. Pure heuristic —
-- owners can adjust from the setup wizard at any time.
UPDATE public.services SET category = 'manicure'
  WHERE category = 'other'
    AND (name ILIKE '%mani%' OR name ILIKE '%nail art%');

UPDATE public.services SET category = 'pedicure'
  WHERE category = 'other' AND name ILIKE '%pedi%';

UPDATE public.services SET category = 'acrylic'
  WHERE category = 'other' AND name ILIKE '%acrylic%';

UPDATE public.services SET category = 'gel'
  WHERE category = 'other' AND name ILIKE '%gel%';

UPDATE public.services SET category = 'dip'
  WHERE category = 'other' AND name ILIKE '%dip%';

COMMENT ON COLUMN public.services.category IS
  'Service category for grouping on the public booking page and the '
  'setup-wizard menu. One of: manicure | pedicure | acrylic | gel | '
  'dip | waxing | other (default).';
