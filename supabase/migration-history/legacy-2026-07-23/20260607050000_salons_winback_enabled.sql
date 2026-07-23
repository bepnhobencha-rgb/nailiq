-- Opt-out win-back: after a desk no-show, email the guest a friendly "we missed
-- you — rebook" note. On by default (retention); owner can disable in Settings.
ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS winback_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.salons.winback_enabled IS
  'When true, a no-show triggers a friendly win-back/rebook email to the guest. Default true.';
