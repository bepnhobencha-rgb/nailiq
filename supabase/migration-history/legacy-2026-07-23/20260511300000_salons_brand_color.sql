-- Per-salon brand color for the public booking page (`/[slug]`).
-- The dashboard remains untouched — this column is consumed only by
-- `resolvePublicBookingPage` which injects it as a CSS variable on
-- the booking page wrapper.
--
-- Stored as a 6-digit hex literal (`#RRGGBB`); CHECK constraint
-- rejects shorthand 3-digit, missing `#`, or non-hex characters.

ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS brand_color text NOT NULL DEFAULT '#D4AF37';

ALTER TABLE public.salons
  ADD CONSTRAINT salons_brand_color_hex_chk
  CHECK (brand_color ~ '^#[0-9A-Fa-f]{6}$');

COMMENT ON COLUMN public.salons.brand_color IS
  'Per-salon primary color for the public booking page. 6-digit '
  'hex (#RRGGBB). Default #D4AF37 (NailIQ gold). Dashboard '
  'surfaces are unaffected — only /[slug] consumes this.';
