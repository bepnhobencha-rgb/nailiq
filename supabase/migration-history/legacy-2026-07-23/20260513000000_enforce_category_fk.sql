-- Task #07 — enforce FK from `services.category` → `service_categories.slug`.
--
-- Background: the public booking page's `BookingFlowServicePanel`
-- groups services by their `category` column. When a service row
-- carries a slug that isn't in `service_categories.slug`, the
-- grouper falls through to the orphan "other" bucket and renders
-- the menu as a flat grid with no headers. This silently broke
-- the receptionist-facing accordion for the `liam-nails` tenant
-- in production (services had `category = 'dip'` while the
-- canonical slug is `dip_powder`).
--
-- PM ran a one-time `UPDATE services SET category = 'dip_powder'
-- WHERE category = 'dip'` to fix the visible drift. This
-- migration is the *forward-compatibility* half — a FK so a
-- future hand-typed write can't silently re-introduce the drift.
--
-- Safety
--   - Verified at apply time (2026-05-13) that zero rows across
--     all tenants (including soft-deleted) had a `category`
--     value missing from `service_categories.slug`. The FK adds
--     cleanly without ALTER ... NOT VALID.
--   - `service_categories.slug` already has a UNIQUE index
--     (`service_categories_slug_key`), satisfying the FK target
--     uniqueness requirement.
--
-- Cascade choice
--   - ON UPDATE CASCADE: if SuperAdmin renames a category slug
--     (rare but legal — the column is owner-editable in the
--     SuperAdmin panel), every service referencing it gets the
--     new slug in the same transaction. Without CASCADE the
--     rename would fail with a FK violation.
--   - ON DELETE NO ACTION (implicit): `service_categories` is
--     soft-deleted via `deleted_at` rather than hard-deleted, so
--     this clause is dormant in normal flow. If a future op
--     attempts a hard DELETE on a referenced category, Postgres
--     will refuse — protecting orphaned services from a silent
--     re-bucket.
--
-- Idempotent: dropped+re-added via `IF EXISTS` so re-running the
-- migration on a partially-applied database is safe.

ALTER TABLE public.services
  DROP CONSTRAINT IF EXISTS services_category_fk;

ALTER TABLE public.services
  ADD CONSTRAINT services_category_fk
  FOREIGN KEY (category)
  REFERENCES public.service_categories (slug)
  ON UPDATE CASCADE;

COMMENT ON CONSTRAINT services_category_fk ON public.services IS
  'Task #07 — prevents `services.category` drift from the canonical `service_categories.slug` list. ON UPDATE CASCADE keeps service rows in sync when SuperAdmin renames a category. ON DELETE NO ACTION is dormant (categories are soft-deleted).';
