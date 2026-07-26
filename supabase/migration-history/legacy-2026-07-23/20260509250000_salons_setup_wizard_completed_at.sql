-- 2026-05-09 — Force-wizard gate (Issue #1 from QA fix/onboarding-ux follow-up)
--
-- Adds `setup_wizard_completed_at` so the dashboard can refuse to render
-- until the salon has been through the name + slug + timezone wizard.
-- NULL means "needs wizard"; a non-null timestamp means the user has
-- confirmed/edited the salon identity at least once.
--
-- Backfill rule: any existing salon with a non-empty name AND at least
-- one service is treated as having been through the wizard already
-- (production users shouldn't be force-redirected to /register/setup).
-- Other salons stay NULL so half-completed test rows are caught the
-- next time the owner signs in.

alter table public.salons
  add column if not exists setup_wizard_completed_at timestamptz null;

update public.salons s
   set setup_wizard_completed_at = s.created_at
 where s.setup_wizard_completed_at is null
   and coalesce(btrim(s.name), '') <> ''
   and exists (
     select 1
       from public.services sv
      where sv.salon_id = s.id
   );

comment on column public.salons.setup_wizard_completed_at is
  'NULL until the owner finishes /register/setup (name + slug + timezone). '
  'Dashboard redirects to the wizard while NULL.';
