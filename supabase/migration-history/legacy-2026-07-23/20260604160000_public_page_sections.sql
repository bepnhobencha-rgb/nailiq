-- Phase 2: publish the web-builder sections on the public booking page.
-- Opt-in per salon (default OFF) so no existing salon's public page changes
-- until the owner turns it on.
ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS public_sections_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.salons.public_sections_enabled IS
  'When true, the salon''s visible salon_page_sections render on the public booking page (/[slug]) above the booking flow. Default false.';

-- Allow anonymous + authenticated visitors to read VISIBLE sections so the
-- public page (anon client) can render them. The existing member policy still
-- grants owners full read/write to all their rows (policies are OR-ed).
DROP POLICY IF EXISTS salon_page_sections_public_read ON public.salon_page_sections;
CREATE POLICY salon_page_sections_public_read
  ON public.salon_page_sections
  FOR SELECT
  TO anon, authenticated
  USING (is_visible = true);
