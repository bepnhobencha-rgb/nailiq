-- Phase 1 — business vertical per tenant.
-- Free-form text (no CHECK) so new verticals can be added without a migration;
-- the app's vertical registry + Admin dropdown constrain the value, and
-- resolveVertical() falls back to 'nail_salon' for any unknown slug.
ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS vertical text NOT NULL DEFAULT 'nail_salon';

COMMENT ON COLUMN public.salons.vertical IS
  'Business vertical slug (nail_salon | head_spa | …). Drives schema.org type, AI prompt descriptors, staff-role label, hero tagline, and seed catalogue via src/shared/verticals/registry.ts. Unknown values fall back to nail_salon.';
