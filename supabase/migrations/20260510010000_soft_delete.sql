-- 2026-05-10 — Soft delete for critical tables.
--
-- Adds nullable timestamp columns. NULL = live; non-NULL = soft-deleted
-- (or, for salons, soft-archived). All read paths in this migration's
-- companion code change filter `where deleted_at is null` to hide them
-- from normal flows; SuperAdmin restore flips the column back to NULL.
--
-- Scope of this migration:
-- - Columns are added to all 5 tables right now even though only
--   services + staff have a user-facing soft-delete code path today.
--   bookings + client_profiles + salons reserve the column for a
--   follow-up (cancel-vs-purge bookings, archive ex-clients, archive
--   salons). Tracking the column from day one avoids a second
--   migration when those flows ship.
--
-- KNOWN LIMITATION (not fixed here, deferred):
-- - `client_profiles.phone` and `salons.slug` are globally unique. A
--   soft-deleted/archived row keeps claiming its identifier. Re-using
--   the same phone or slug after soft-delete will hit the unique
--   constraint until either:
--     (a) the row is hard-deleted by SuperAdmin, or
--     (b) a follow-up migration replaces the unique constraint with a
--         partial unique index `where deleted_at/archived_at is null`.
--   That follow-up requires checking every consumer of the upsert
--   pattern (notably public booking client-profile lookup) before
--   shipping; out of scope for the urgent slice.

alter table public.bookings
  add column if not exists deleted_at timestamptz;

alter table public.services
  add column if not exists deleted_at timestamptz;

alter table public.staff
  add column if not exists deleted_at timestamptz;

alter table public.client_profiles
  add column if not exists deleted_at timestamptz;

alter table public.salons
  add column if not exists archived_at timestamptz;

comment on column public.bookings.deleted_at is
  'Soft-delete sentinel. NULL = live row; non-NULL = hidden from all '
  'read paths and excluded from conflict checks. Reserved — no '
  'user-facing path soft-deletes bookings yet (cancel uses status).';
comment on column public.services.deleted_at is
  'Soft-delete sentinel. NULL = live row; non-NULL = hidden from '
  'booking flow, dashboard, conflict checks. SuperAdmin can restore.';
comment on column public.staff.deleted_at is
  'Soft-delete sentinel. NULL = live row; non-NULL = hidden from '
  'booking flow, receptionist grid. SuperAdmin can restore.';
comment on column public.client_profiles.deleted_at is
  'Soft-delete sentinel. NULL = live row. Reserved — no user-facing '
  'path soft-deletes client_profiles yet.';
comment on column public.salons.archived_at is
  'Soft-archive sentinel. NULL = live tenant. Reserved — no user-'
  'facing path archives salons yet.';

-- Index supporting WHERE deleted_at is null on the per-salon hot
-- queries (services list, staff list). Partial — only the live rows
-- get indexed, so the index stays small.
create index if not exists services_salon_alive_idx
  on public.services (salon_id)
  where deleted_at is null;

create index if not exists staff_salon_alive_idx
  on public.staff (salon_id)
  where deleted_at is null;
