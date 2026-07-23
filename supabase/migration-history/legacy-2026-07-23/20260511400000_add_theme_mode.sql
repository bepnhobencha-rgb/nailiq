-- Per-salon light/dark theme for the public booking page (`/[slug]`).
-- Companion to `brand_color` (PR #109). The dashboard remains
-- dark-only; this column is consumed only by `resolvePublicBookingPage`
-- which injects `--booking-bg`, `--booking-text`, etc. on the page
-- wrapper according to the salon's choice.

ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS theme_mode text
    NOT NULL DEFAULT 'dark'
    CHECK (theme_mode IN ('dark', 'light'));

COMMENT ON COLUMN public.salons.theme_mode IS
  'Per-salon theme for the public booking page. ''dark'' (default) or '
  '''light''. Dashboard surfaces are unaffected — only /[slug] consumes '
  'this.';
