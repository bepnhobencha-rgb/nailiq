-- A nail design can be performed through several salon services and may
-- recommend several add-ons.  The legacy scalar columns remain as the default
-- pair so older app releases continue to work during a rolling deployment.

create table if not exists public.nail_design_service_mappings (
  design_id uuid not null references public.nail_designs(id) on delete cascade,
  salon_id uuid not null references public.salons(id) on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  mapping_type text not null check (mapping_type in ('service', 'addon')),
  is_default boolean not null default false,
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  primary key (design_id, service_id),
  constraint nail_design_service_mappings_design_salon_fk
    foreign key (design_id, salon_id)
    references public.nail_designs(id, salon_id) on delete cascade
);

create unique index if not exists nail_design_one_default_service_idx
  on public.nail_design_service_mappings(design_id)
  where mapping_type = 'service' and is_default;

create index if not exists nail_design_service_mappings_catalog_idx
  on public.nail_design_service_mappings(salon_id, design_id, mapping_type, sort_order);

alter table public.nail_design_service_mappings enable row level security;

drop policy if exists "salon members read nail design mappings"
  on public.nail_design_service_mappings;

create policy "salon members read nail design mappings"
on public.nail_design_service_mappings for select to authenticated
using (exists (
  select 1 from public.salon_members sm
  where sm.salon_id = nail_design_service_mappings.salon_id
    and sm.user_id = (select auth.uid())
));

revoke all on public.nail_design_service_mappings from anon, authenticated;
grant select on public.nail_design_service_mappings to authenticated;
grant all on public.nail_design_service_mappings to service_role;

create or replace function public.replace_nail_design_service_mappings(
  p_design_id uuid,
  p_salon_id uuid,
  p_service_ids uuid[],
  p_addon_service_ids uuid[],
  p_default_service_id uuid default null
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_service_ids uuid[] := coalesce(p_service_ids, '{}'::uuid[]);
  v_addon_ids uuid[] := coalesce(p_addon_service_ids, '{}'::uuid[]);
begin
  if not exists (
    select 1 from public.nail_designs d
    where d.id = p_design_id and d.salon_id = p_salon_id and d.deleted_at is null
  ) then
    raise exception 'nail_design_not_found' using errcode = 'P0002';
  end if;

  if p_default_service_id is not null and not (p_default_service_id = any(v_service_ids)) then
    raise exception 'default_service_not_selected' using errcode = '22023';
  end if;

  if exists (
    select 1 from unnest(v_service_ids) requested(id)
    left join public.services s on s.id = requested.id
      and s.salon_id = p_salon_id and s.deleted_at is null and not s.is_addon
    where s.id is null
  ) or exists (
    select 1 from unnest(v_addon_ids) requested(id)
    left join public.services s on s.id = requested.id
      and s.salon_id = p_salon_id and s.deleted_at is null and s.is_addon
    where s.id is null
  ) then
    raise exception 'invalid_nail_design_service_mapping' using errcode = '23514';
  end if;

  delete from public.nail_design_service_mappings
  where design_id = p_design_id and salon_id = p_salon_id;

  insert into public.nail_design_service_mappings
    (design_id, salon_id, service_id, mapping_type, is_default, sort_order)
  select p_design_id, p_salon_id, requested.id, 'service',
    requested.id = coalesce(p_default_service_id, v_service_ids[1]), requested.ord - 1
  from unnest(v_service_ids) with ordinality requested(id, ord)
  on conflict (design_id, service_id) do nothing;

  insert into public.nail_design_service_mappings
    (design_id, salon_id, service_id, mapping_type, is_default, sort_order)
  select p_design_id, p_salon_id, requested.id, 'addon', false, requested.ord - 1
  from unnest(v_addon_ids) with ordinality requested(id, ord)
  on conflict (design_id, service_id) do nothing;

  update public.nail_designs
  set service_id = coalesce(p_default_service_id, v_service_ids[1]),
      addon_service_id = v_addon_ids[1],
      updated_at = now()
  where id = p_design_id and salon_id = p_salon_id;
end;
$$;

revoke all on function public.replace_nail_design_service_mappings(uuid, uuid, uuid[], uuid[], uuid)
  from public, anon, authenticated;
grant execute on function public.replace_nail_design_service_mappings(uuid, uuid, uuid[], uuid[], uuid)
  to service_role;

-- Backfill every existing Smart Quote mapping without changing its meaning.
insert into public.nail_design_service_mappings
  (design_id, salon_id, service_id, mapping_type, is_default, sort_order)
select id, salon_id, service_id, 'service', true, 0
from public.nail_designs
where service_id is not null and deleted_at is null
on conflict (design_id, service_id) do nothing;

insert into public.nail_design_service_mappings
  (design_id, salon_id, service_id, mapping_type, is_default, sort_order)
select id, salon_id, addon_service_id, 'addon', false, 0
from public.nail_designs
where addon_service_id is not null and deleted_at is null
on conflict (design_id, service_id) do nothing;
