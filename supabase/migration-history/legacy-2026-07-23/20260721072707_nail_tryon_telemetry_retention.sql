create table public.nail_tryon_events (
  id bigint generated always as identity primary key,
  salon_id uuid not null references public.salons(id) on delete cascade,
  tryon_session_id uuid references public.nail_tryon_sessions(id) on delete set null,
  event_name text not null check (event_name in (
    'upload_received', 'quality_passed', 'quality_rejected',
    'catalog_viewed', 'generation_started', 'generation_ready',
    'generation_failed', 'booking_attached', 'expired_deleted'
  )),
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (jsonb_typeof(properties) = 'object')
);

create index nail_tryon_events_salon_created_idx
  on public.nail_tryon_events(salon_id, created_at desc);
create index nail_tryon_events_funnel_idx
  on public.nail_tryon_events(event_name, created_at desc);

alter table public.nail_tryon_events enable row level security;
revoke all on public.nail_tryon_events from public, anon, authenticated;
grant all on public.nail_tryon_events to service_role;
grant usage, select on sequence public.nail_tryon_events_id_seq to service_role;

comment on table public.nail_tryon_events is
  'PII-free Nail Try-On funnel telemetry. Never store image bytes, URLs, tokens, phone, email, or names.';
