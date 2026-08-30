-- Reference data — the rows the SCHEMA cannot work without.
--
-- Applied after prelude.sql and schema.sql, before the E2E seed.
--
-- ── What this is, and what it is emphatically not ────────────────────────────
--
-- These are LOOKUP tables: global, salon-agnostic, and part of the application's
-- definition rather than anyone's data. `services.category` has a foreign key
-- into service_categories, so an empty service_categories means the E2E seed
-- cannot create a single service — which is exactly how CI failed:
--
--     insert or update on table "services" violates foreign key constraint
--     "services_category_fkey"
--
-- This file is NOT a channel for production data. It carries no customers, no
-- bookings, no staff, no salons, no auth users, no credentials. Production's
-- 11,226 customers stay in production. If anyone is ever tempted to add a real
-- salon here "just so a test can see something", the answer is no: seed it in
-- the test, with a marker, and let the sweep take it away.
--
-- Kept idempotent so re-running it (or seeding twice, which CI does on purpose)
-- is a no-op.

-- ── service_categories (13 rows) ────────────────────────────────────────────
-- Referenced by services.category. `head_spa` and `eyelashes` are here because
-- real salons needed them — Hi-Lite is a head spa, and Wix's lash services use
-- nail wording so they had to be given a category of their own.
INSERT INTO public.service_categories (slug, name_en, name_vi, sort_order) VALUES
  ('head_spa',   'Head Spa Packages', 'Gói Head Spa',      0),
  ('manicure',   'Manicure',          'Làm móng tay',      1),
  ('pedicure',   'Pedicure',          'Làm móng chân',     2),
  ('acrylic',    'Acrylic',           'Acrylic',           3),
  ('gel',        'Gel',               'Gel',               4),
  ('dip_powder', 'Dip Powder',        'Bột nhúng',         5),
  ('nail_art',   'Nail Art',          'Nghệ thuật móng',   6),
  ('removal',    'Removal',           'Tháo móng',         7),
  ('spa',        'Spa & Treatments',  'Spa & Chăm sóc',    8),
  ('waxing',     'Waxing',            'Wax lông',          9),
  ('kids',       'Kids',              'Trẻ em',           10),
  ('eyelashes',  'Eyelashes',         'Nối mi',           11),
  ('other',      'Other',             'Khác',             99)
ON CONFLICT (slug) DO NOTHING;

-- ── platform_flags (5 baseline rows; forward migrations may add more) ───────
-- Platform-wide switches. Values match production, so the suite exercises the
-- same defaults the product ships with — and note that sms_enabled is false
-- there too, which is one more reason a test can never text a real person.
INSERT INTO public.platform_flags (key, enabled) VALUES
  ('demo_otp_enabled',       false),
  ('email_enabled',          true),
  ('new_salon_registration', true),
  ('sms_enabled',            false),
  ('stripe_billing_enabled', false)
ON CONFLICT (key) DO NOTHING;

-- ── private system buckets (1 row) ─────────────────────────────────────────
-- Configuration, not customer data. The folded schema deliberately omits the
-- original top-level INSERT so the migration remains schema-only; local/test
-- environments still need the same private bucket that production uses.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'nail-tryon',
  'nail-tryon',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
