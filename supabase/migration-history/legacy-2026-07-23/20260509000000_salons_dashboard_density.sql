-- Per-salon UI density preference (Simple ↔ Balanced ↔ Pro). Orthogonal
-- to `dashboard_preset` (which governs layout zones) and
-- `dashboard_modules` (which governs feature flags). Density tunes
-- visual rhythm only — booking-block min height, label visibility,
-- skill row visibility, slot height — without altering the three-zone
-- layout per `docs/DASHBOARD_LAYOUT_RULES.md`.
--
-- 'balanced' is the existing visual identity; existing rows pick it up
-- via the NOT NULL DEFAULT, so no backfill is needed and no surface
-- regresses.

ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS dashboard_density text NOT NULL DEFAULT 'balanced'
    CHECK (dashboard_density IN ('simple', 'balanced', 'pro'));

COMMENT ON COLUMN public.salons.dashboard_density IS
  'UI density preference for the receptionist desk. simple=less chrome / larger spacing; balanced=current default; pro=tighter spacing / more labels. Orthogonal to dashboard_preset + dashboard_modules.';
