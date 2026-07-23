-- How an add-on occupies the schedule:
--   'sequential' (default) → done AFTER the main service, adds its duration.
--   'concurrent'           → done DURING the main service, adds $0 time.
-- Only meaningful when is_addon = true.
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS addon_timing text NOT NULL DEFAULT 'sequential'
    CHECK (addon_timing IN ('concurrent', 'sequential'));

COMMENT ON COLUMN public.services.addon_timing IS
  'Add-on scheduling: concurrent = runs alongside the main service (+0 time), sequential = runs after (adds duration). Only used when is_addon.';
