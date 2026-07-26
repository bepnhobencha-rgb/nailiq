-- Variable service pricing. A service can be priced three ways:
--   fixed → one price ($47)
--   from  → a starting price ("From $35"); price_cents is the minimum
--   range → a band ("$35–$60"); price_cents = min, price_max_cents = max
-- Default 'fixed' so every existing service is unchanged (backward compatible).

ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS price_type     text    NOT NULL DEFAULT 'fixed',
  ADD COLUMN IF NOT EXISTS price_max_cents integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'services_price_type_check'
  ) THEN
    ALTER TABLE public.services
      ADD CONSTRAINT services_price_type_check
      CHECK (price_type IN ('fixed', 'from', 'range'));
  END IF;
END $$;

COMMENT ON COLUMN public.services.price_type IS
  'fixed | from | range. from/range use price_cents as the minimum; range uses price_max_cents as the max.';
COMMENT ON COLUMN public.services.price_max_cents IS
  'Upper bound for price_type=range. NULL for fixed/from.';
