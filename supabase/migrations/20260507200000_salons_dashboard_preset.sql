-- Workspace preset for the receptionist dashboard. Drives module visibility
-- defaults; the per-flag `dashboard_modules` JSON merges on top in app code.

alter table public.salons
  add column if not exists dashboard_preset text not null default 'reception';

alter table public.salons
  drop constraint if exists salons_dashboard_preset_check;

alter table public.salons
  add constraint salons_dashboard_preset_check
  check (
    dashboard_preset in (
      'minimal',
      'reception',
      'rush_hour',
      'owner',
      'training',
      'tv'
    )
  );

comment on column public.salons.dashboard_preset is
  'Workspace preset (minimal | reception | rush_hour | owner | training | tv). Owner-tunable; base layout for the Receptionist Center; per-flag dashboard_modules overrides merge on top in app.';
