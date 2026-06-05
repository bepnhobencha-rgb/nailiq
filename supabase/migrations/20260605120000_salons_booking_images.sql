-- Per-salon booking-page imagery override (hero + 2 thumbnails). When set,
-- overrides the vertical default so a salon can use its own real photos.
ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS booking_images jsonb;

COMMENT ON COLUMN public.salons.booking_images IS
  'Optional {hero, thumbA, thumbB} base image URLs for the public booking page hero/ambient. Overrides the vertical default (resolveVertical().bookingImagery).';
