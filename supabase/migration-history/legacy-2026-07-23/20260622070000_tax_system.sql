-- Tax system: presets table + per-salon tax_lines + booking tax columns
-- Rates live in DB → future law changes = DB update only, no code deploy.

-- ── 1. Tax presets (superadmin-managed defaults by region) ─────────────────
-- Keyed by timezone for deterministic auto-populate (timezone is already set
-- per-salon and maps 1-to-1 with Canadian provinces / Vietnam).
CREATE TABLE IF NOT EXISTS tax_presets (
  id          uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  timezone    text    NOT NULL UNIQUE,  -- IANA timezone key
  label       text    NOT NULL,
  tax_lines   jsonb   NOT NULL DEFAULT '[]',
  updated_at  timestamptz DEFAULT now()
);

INSERT INTO tax_presets (timezone, label, tax_lines) VALUES
  -- Canada — each province has its own IANA timezone
  ('America/Vancouver',     'BC — British Columbia',          '[{"name":"GST","rate":0.05,"enabled":true}]'),
  ('America/Edmonton',      'AB — Alberta',                   '[{"name":"GST","rate":0.05,"enabled":true}]'),
  ('America/Winnipeg',      'MB — Manitoba',                  '[{"name":"GST","rate":0.05,"enabled":true},{"name":"PST","rate":0.07,"enabled":true}]'),
  ('America/Regina',        'SK — Saskatchewan',              '[{"name":"GST","rate":0.05,"enabled":true},{"name":"PST","rate":0.06,"enabled":true}]'),
  ('America/Toronto',       'ON — Ontario',                   '[{"name":"HST","rate":0.13,"enabled":true}]'),
  ('America/Halifax',       'NS / NB — Atlantic Canada',      '[{"name":"HST","rate":0.15,"enabled":true}]'),
  ('America/Moncton',       'NB — New Brunswick',             '[{"name":"HST","rate":0.15,"enabled":true}]'),
  ('America/St_Johns',      'NL — Newfoundland',              '[{"name":"HST","rate":0.15,"enabled":true}]'),
  ('America/Charlottetown', 'PE — Prince Edward Island',      '[{"name":"HST","rate":0.15,"enabled":true}]'),
  ('America/Montreal',      'QC — Quebec',                    '[{"name":"GST","rate":0.05,"enabled":true},{"name":"QST","rate":0.09975,"enabled":true}]'),
  ('America/Whitehorse',    'YT — Yukon',                     '[{"name":"GST","rate":0.05,"enabled":true}]'),
  ('America/Yellowknife',   'NT — Northwest Territories',     '[{"name":"GST","rate":0.05,"enabled":true}]'),
  ('America/Iqaluit',       'NU — Nunavut',                   '[{"name":"GST","rate":0.05,"enabled":true}]'),
  -- US timezones where services are taxable (WA, MN, SD, NM, HI)
  ('America/Adak',          'HI — Hawaii',                    '[{"name":"GET","rate":0.04,"enabled":true}]'),
  ('Pacific/Honolulu',      'HI — Hawaii',                    '[{"name":"GET","rate":0.04,"enabled":true}]'),
  -- Vietnam
  ('Asia/Ho_Chi_Minh',      'Vietnam',                        '[{"name":"VAT","rate":0.10,"enabled":true}]'),
  ('Asia/Saigon',           'Vietnam',                        '[{"name":"VAT","rate":0.10,"enabled":true}]')
ON CONFLICT (timezone) DO NOTHING;

-- ── 2. Per-salon tax configuration ────────────────────────────────────────
ALTER TABLE salons
  ADD COLUMN IF NOT EXISTS tax_lines jsonb;

-- Auto-populate from preset by timezone match; default to [] when no match.
UPDATE salons s
SET tax_lines = COALESCE(
  (SELECT tp.tax_lines FROM tax_presets tp WHERE tp.timezone = s.timezone LIMIT 1),
  '[]'::jsonb
)
WHERE s.tax_lines IS NULL;

-- ── 3. Tax stamp on bookings ───────────────────────────────────────────────
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS subtotal_cents    integer,
  ADD COLUMN IF NOT EXISTS tax_amount_cents  integer DEFAULT 0;
