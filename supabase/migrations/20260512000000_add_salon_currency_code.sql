-- Per-salon display currency. NailIQ ships in Canada-first markets so
-- the default is CAD; salons in Vietnam display in VND, and we leave
-- USD on the matrix for the small number of US pilot accounts.
--
-- The column is the salon's *display* currency only — it does NOT
-- affect Stripe billing (which stays CAD via the subscription
-- products) and does NOT convert stored `services.price_cents`
-- between currencies. Owners enter prices in their local currency;
-- the integer cents value is interpreted in `currency_code` by every
-- formatter.

ALTER TABLE public.salons
  ADD COLUMN IF NOT EXISTS currency_code text
    NOT NULL DEFAULT 'CAD'
    CHECK (currency_code IN ('CAD','USD','VND'));

-- Best-effort backfill from the existing address text. The full
-- address is stored as a single comma-separated string built by
-- `buildSalonAddressString` ending with the country name, so an
-- ILIKE on the suffix gives us a clean signal.
UPDATE public.salons
  SET currency_code = 'VND'
  WHERE address ILIKE '%vietnam%';

UPDATE public.salons
  SET currency_code = 'USD'
  WHERE currency_code = 'CAD'
    AND address IS NOT NULL
    AND address ILIKE '%united states%';

-- Existing rows without an address (e.g. demo salon) keep the default
-- CAD. Owner can override from the setup wizard after this lands.

COMMENT ON COLUMN public.salons.currency_code IS
  'Display currency for service prices and revenue totals. One of '
  'CAD | USD | VND. Defaults to CAD. Does NOT affect Stripe billing.';
