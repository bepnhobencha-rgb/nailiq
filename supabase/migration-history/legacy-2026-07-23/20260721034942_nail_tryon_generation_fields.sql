alter table public.nail_designs
  add column service_id uuid references public.services(id) on delete set null,
  add column addon_service_id uuid references public.services(id) on delete set null,
  add column style_tags text[] not null default '{}',
  add column palette jsonb not null default '[]'::jsonb,
  add column version integer not null default 1 check (version > 0),
  add column deleted_at timestamptz;

alter table public.nail_tryon_sessions
  drop constraint nail_tryon_sessions_status_check,
  drop constraint nail_tryon_sessions_quality_code_check,
  add column consent_at timestamptz not null default now(),
  add column provider_model text,
  add column design_version integer,
  add column deleted_at timestamptz,
  add constraint nail_tryon_sessions_status_check check (
    status in ('uploaded', 'quality_rejected', 'quality_passed', 'generating', 'ready', 'failed', 'attached', 'deleted', 'expired')
  ),
  add constraint nail_tryon_sessions_quality_code_check check (
    quality_code in ('hand_not_found', 'multiple_hands', 'blurred', 'too_dark', 'too_bright', 'nails_occluded', 'unsupported_format', 'wrong_pose')
  );

alter table public.booking_nail_looks
  add column design_version integer,
  add column design_snapshot jsonb not null default '{}'::jsonb,
  add column disclaimer_version text not null default 'nail-tryon-v1';

create index nail_designs_public_catalog_idx
  on public.nail_designs(salon_id, sort_order, created_at)
  where is_active and deleted_at is null;
