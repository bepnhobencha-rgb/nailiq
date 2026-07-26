-- Phase 6.2: Party Guest Passport — per-salon party link configuration.
-- Stored as JSONB with safe defaults so fields can be added without new
-- migrations. loadPartyLinkPage reads this and exposes safe booleans to
-- the public party page (no secrets / RLS-protected data leaked).

ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS party_config JSONB NOT NULL DEFAULT '{}'::JSONB;

COMMENT ON COLUMN public.salons.party_config IS
  'Per-salon config for the Party Guest Passport public page. '
  'Keys and defaults: '
  'show_group_progress (true), show_add_to_calendar (true), '
  'show_privacy_note (true), show_arrival_note (true), '
  'require_phone (true), allow_phone_optional (false).';
