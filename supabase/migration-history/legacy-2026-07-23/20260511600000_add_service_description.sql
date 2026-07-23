-- Service descriptions + curation flags.
--
-- `description` is rendered as a one-line muted hint under the service
-- name on the public booking page. NULLable so legacy rows don't need
-- a backfill (the renderer simply hides the line). A length cap is
-- enforced at the application layer (100 chars) to keep tiles uniform;
-- enforcing in the DB would force a schema migration each time copy
-- guidance changes.
--
-- `is_popular` surfaces a small gold badge on the public booking page —
-- "Popular" social proof for the highest-traffic services. The salon
-- can toggle from the setup wizard.
--
-- `is_featured` lifts the service tile slightly (larger card + subtle
-- glow border). Reserved for "hero" services the salon wants to push.

ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS is_popular boolean NOT NULL DEFAULT false;

ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.services.description IS
  'One-line marketing description shown under the service name on the '
  'public booking page. Recommended ≤100 chars; enforced in the app '
  'layer (addService/updateService).';

COMMENT ON COLUMN public.services.is_popular IS
  'When true, the public booking page renders a small "Popular" badge '
  'on this service. Owner-toggled from the setup wizard.';

COMMENT ON COLUMN public.services.is_featured IS
  'When true, the public booking page renders this service in a '
  'larger, subtly-glowing tile. Reserved for hero services.';
