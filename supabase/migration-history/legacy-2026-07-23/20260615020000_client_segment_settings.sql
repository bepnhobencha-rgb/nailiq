-- Per-salon thresholds for the Clients lifecycle segmentation (new / regular /
-- at-risk). NULL means "use the app defaults" (new ≤ 1 visit, at-risk > 60 days)
-- — the exact previous hardcoded behaviour, so nothing changes until a salon
-- edits it in Settings. Nullable ADD COLUMN = metadata-only, no table rewrite.
ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS client_segment_settings jsonb;

COMMENT ON COLUMN public.salons.client_segment_settings IS
  'Clients lifecycle thresholds: {"new_max_visits":1,"at_risk_days":60}. NULL = app defaults.';
