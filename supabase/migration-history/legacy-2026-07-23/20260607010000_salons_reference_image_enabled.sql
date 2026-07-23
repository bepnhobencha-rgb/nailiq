-- Per-salon override for the optional "reference image" upload in booking.
-- NULL = use the vertical default (nail_salon=on, head_spa=off). Owner toggle
-- writes an explicit true/false.
ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS reference_image_enabled boolean;

COMMENT ON COLUMN public.salons.reference_image_enabled IS
  'Override for the booking reference-image upload. NULL = vertical default (nail on, head_spa off).';
