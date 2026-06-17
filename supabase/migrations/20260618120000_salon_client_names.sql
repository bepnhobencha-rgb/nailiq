-- Per-salon customer display-name override (tenant-isolated rename).
--
-- `client_profiles` is shared by phone ACROSS salons, so a salon must never
-- rewrite the canonical name (it would change another tenant's view). This table
-- holds a name a salon chose for a customer — read with PRIORITY over the shared
-- profile name, but ONLY within that salon. Other salons are unaffected.

create table if not exists public.salon_client_names (
  salon_id     uuid        not null references public.salons (id) on delete cascade,
  phone        text        not null,             -- canonical, matches client_profiles.phone
  display_name text        not null,
  updated_at   timestamptz not null default now(),
  primary key (salon_id, phone)
);

alter table public.salon_client_names enable row level security;
-- Service-role only — no public policies (anon/auth cannot read or write).

-- Typeahead now prefers the per-salon override name (search + display).
create or replace function public.search_salon_client_typeahead(
  p_salon_id uuid,
  p_query text,
  p_limit int default 8
)
returns table (
  phone text,
  name text,
  is_vip boolean,
  visit_count int,
  last_visit_at timestamptz
)
language sql
security definer
set search_path to 'public'
stable
as $function$
  with q as (
    select nullif(btrim(p_query), '') as raw
  ),
  d as (
    select regexp_replace(coalesce((select raw from q), ''), '\D', '', 'g') as digits
  )
  select
    cp.phone,
    coalesce(scn.display_name, cp.name) as name,
    coalesce(cp.is_vip, false) as is_vip,
    count(b.*) filter (where b.status <> 'cancelled')::int as visit_count,
    max(b.start_time_utc) as last_visit_at
  from public.client_profiles cp
  join public.bookings b
    on b.client_phone = cp.phone
   and b.salon_id = p_salon_id
  left join public.salon_client_names scn
    on scn.salon_id = p_salon_id
   and scn.phone = cp.phone
  where cp.deleted_at is null
    and (select raw from q) is not null
    and (
      ( (select digits from d) <> '' and cp.phone like '%' || (select digits from d) || '%' )
      or ( coalesce(scn.display_name, cp.name) ilike '%' || (select raw from q) || '%' )
    )
  group by cp.phone, cp.name, cp.is_vip, scn.display_name
  order by max(b.start_time_utc) desc nulls last
  limit greatest(1, least(coalesce(p_limit, 8), 20));
$function$;

revoke all on function public.search_salon_client_typeahead(uuid, text, int) from public, anon, authenticated;
grant execute on function public.search_salon_client_typeahead(uuid, text, int) to service_role;
