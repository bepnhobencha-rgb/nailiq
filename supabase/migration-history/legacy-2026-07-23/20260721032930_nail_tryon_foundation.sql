-- Nail Try-On MVP foundation.
-- Customer images remain private and are only accessed by trusted server code.

create table public.nail_designs (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text,
  preview_path text not null check (preview_path !~ '(^|/)\.\.(/|$)'),
  prompt_hint text,
  is_active boolean not null default true,
  sort_order integer not null default 0 check (sort_order >= 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, salon_id)
);

create table public.nail_tryon_sessions (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  design_id uuid,
  anonymous_token_hash text not null unique check (char_length(anonymous_token_hash) >= 43),
  source_image_path text not null check (source_image_path !~ '(^|/)\.\.(/|$)'),
  result_image_path text check (result_image_path !~ '(^|/)\.\.(/|$)'),
  status text not null default 'uploaded'
    check (status in ('uploaded', 'quality_rejected', 'queued', 'processing', 'completed', 'failed', 'expired')),
  quality_code text check (quality_code in ('hand_not_found', 'multiple_hands', 'blurred', 'too_dark', 'too_bright', 'nails_occluded', 'unsupported_format')),
  provider text,
  provider_request_id text,
  error_code text,
  consent_version text not null,
  attached_at timestamptz,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nail_tryon_sessions_design_fk foreign key (design_id, salon_id)
    references public.nail_designs(id, salon_id) on delete restrict,
  unique (id, salon_id)
);

create table public.booking_nail_looks (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  tryon_session_id uuid not null,
  design_id uuid,
  created_at timestamptz not null default now(),
  constraint booking_nail_looks_session_fk foreign key (tryon_session_id, salon_id)
    references public.nail_tryon_sessions(id, salon_id) on delete restrict,
  constraint booking_nail_looks_design_fk foreign key (design_id, salon_id)
    references public.nail_designs(id, salon_id) on delete restrict,
  unique (booking_id),
  unique (tryon_session_id)
);

-- Storage deletion is performed by a service worker. Database cron must never
-- delete storage metadata directly because that can orphan the object itself.
create table public.nail_tryon_cleanup_queue (
  id bigint generated always as identity primary key,
  tryon_session_id uuid not null references public.nail_tryon_sessions(id) on delete cascade,
  object_path text not null,
  attempts integer not null default 0 check (attempts between 0 and 20),
  available_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (tryon_session_id, object_path)
);

create index nail_designs_salon_active_sort_idx
  on public.nail_designs(salon_id, is_active, sort_order);
create index nail_tryon_sessions_expiry_idx
  on public.nail_tryon_sessions(expires_at) where status <> 'expired';
create index nail_tryon_sessions_token_idx
  on public.nail_tryon_sessions(anonymous_token_hash);
create index booking_nail_looks_salon_idx
  on public.booking_nail_looks(salon_id, created_at desc);
create index nail_tryon_cleanup_ready_idx
  on public.nail_tryon_cleanup_queue(available_at) where processed_at is null;

create function public.validate_booking_nail_look_salon()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.bookings b
    where b.id = new.booking_id and b.salon_id = new.salon_id
  ) then
    raise exception 'booking_nail_look_salon_mismatch' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger booking_nail_looks_validate_salon
before insert or update on public.booking_nail_looks
for each row execute function public.validate_booking_nail_look_salon();

create function public.queue_expired_nail_tryon_sessions(p_limit integer default 200)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  queued_count integer;
begin
  if p_limit < 1 or p_limit > 1000 then
    raise exception 'invalid_cleanup_limit' using errcode = '22023';
  end if;

  with expired as (
    select s.id, s.source_image_path, s.result_image_path
    from public.nail_tryon_sessions s
    where s.status <> 'expired' and s.expires_at <= now()
    order by s.expires_at
    for update skip locked
    limit p_limit
  ), paths as (
    select id, source_image_path as object_path from expired
    union all
    select id, result_image_path from expired where result_image_path is not null
  ), queued as (
    insert into public.nail_tryon_cleanup_queue(tryon_session_id, object_path)
    select id, object_path from paths
    on conflict do nothing
    returning 1
  )
  update public.nail_tryon_sessions s
  set status = 'expired', updated_at = now()
  where s.id in (select id from expired);

  get diagnostics queued_count = row_count;
  return queued_count;
end;
$$;

revoke all on function public.validate_booking_nail_look_salon() from public, anon, authenticated;
revoke all on function public.queue_expired_nail_tryon_sessions(integer) from public, anon, authenticated;
grant execute on function public.queue_expired_nail_tryon_sessions(integer) to service_role;

alter table public.nail_designs enable row level security;
alter table public.nail_tryon_sessions enable row level security;
alter table public.booking_nail_looks enable row level security;
alter table public.nail_tryon_cleanup_queue enable row level security;

create policy "salon members read nail designs"
on public.nail_designs for select to authenticated
using (exists (
  select 1 from public.salon_members sm
  where sm.salon_id = nail_designs.salon_id and sm.user_id = (select auth.uid())
));

create policy "salon managers insert nail designs"
on public.nail_designs for insert to authenticated
with check (exists (
  select 1 from public.salon_members sm
  where sm.salon_id = nail_designs.salon_id
    and sm.user_id = (select auth.uid()) and sm.role in ('owner', 'admin')
));

create policy "salon managers update nail designs"
on public.nail_designs for update to authenticated
using (exists (
  select 1 from public.salon_members sm
  where sm.salon_id = nail_designs.salon_id
    and sm.user_id = (select auth.uid()) and sm.role in ('owner', 'admin')
))
with check (exists (
  select 1 from public.salon_members sm
  where sm.salon_id = nail_designs.salon_id
    and sm.user_id = (select auth.uid()) and sm.role in ('owner', 'admin')
));

create policy "salon managers delete nail designs"
on public.nail_designs for delete to authenticated
using (exists (
  select 1 from public.salon_members sm
  where sm.salon_id = nail_designs.salon_id
    and sm.user_id = (select auth.uid()) and sm.role in ('owner', 'admin')
));

create policy "salon members read attached nail looks"
on public.booking_nail_looks for select to authenticated
using (exists (
  select 1 from public.salon_members sm
  where sm.salon_id = booking_nail_looks.salon_id and sm.user_id = (select auth.uid())
));

revoke all on public.nail_designs, public.nail_tryon_sessions,
  public.booking_nail_looks, public.nail_tryon_cleanup_queue from anon, authenticated;
grant select, insert, update, delete on public.nail_designs to authenticated;
grant select on public.booking_nail_looks to authenticated;
grant all on public.nail_designs, public.nail_tryon_sessions,
  public.booking_nail_looks, public.nail_tryon_cleanup_queue to service_role;
grant usage, select on sequence public.nail_tryon_cleanup_queue_id_seq to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'nail-tryon', 'nail-tryon', false, 10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Intentionally no storage.objects policy for this bucket. Upload, signed-read,
-- and deletion are server-mediated with a non-public service credential.
