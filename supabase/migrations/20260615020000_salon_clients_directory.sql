-- Salon client directory — per-salon membership + server-side search RPC.
--
-- WHY: client_profiles is GLOBAL (phone-keyed, shared across salons). The
-- Clients page previously derived a salon's directory from its own bookings
-- only, so imported contacts with no booking (Hi-Lite: 9,476 Square contacts)
-- were invisible + unsearchable. This adds an explicit per-salon membership
-- table so a salon can "own" clients beyond its bookings WITHOUT ever exposing
-- one salon's clients to another:
--   * scope is ALWAYS by salon_clients.salon_id — never by square_customer_id
--     (which would become ambiguous the moment a 2nd salon connects Square).
--   * RLS on + anon/authenticated revoked; all reads go through a
--     SECURITY DEFINER RPC invoked with the service-role client AFTER the
--     dashboard loader has authenticated the viewer's role + salon.

-- ── 1. Membership table ─────────────────────────────────────────────────────
create table if not exists public.salon_clients (
  id uuid primary key default gen_random_uuid(),
  salon_id uuid not null references public.salons(id) on delete cascade,
  client_profile_id uuid not null references public.client_profiles(id) on delete cascade,
  -- 'square_import' | 'manual' | 'booking' | ... — provenance, not used for scoping.
  source text not null default 'manual',
  -- e.g. the square_customer_id this row was imported from (audit/provenance only).
  external_ref text,
  created_at timestamptz not null default now(),
  unique (salon_id, client_profile_id)
);

create index if not exists salon_clients_salon_idx
  on public.salon_clients(salon_id);
create index if not exists salon_clients_profile_idx
  on public.salon_clients(client_profile_id);

-- RLS: default-deny. No policies for anon/authenticated → they read nothing.
-- The service-role client (used by the dashboard loader after its role gate)
-- bypasses RLS; the SECURITY DEFINER RPC below is the only sanctioned read path.
alter table public.salon_clients enable row level security;
revoke all on public.salon_clients from anon, authenticated;

-- ── 2. Search RPC ───────────────────────────────────────────────────────────
-- Returns one page of a salon's client directory = (distinct booking phones at
-- this salon) ∪ (salon_clients membership), de-duped by phone, filtered by a
-- name/phone search, ordered, paginated. Each row carries the per-salon visit /
-- last-visit / spend aggregates + the full filtered total (for pagination).
-- Scoped strictly to p_salon_id — cross-salon data is never reachable.
create or replace function public.search_salon_clients(
  p_salon_id uuid,
  p_search   text,
  p_limit    int,
  p_offset   int
)
returns table (
  client_profile_id uuid,
  phone             text,
  name              text,
  email             text,
  is_vip            boolean,
  notes             text,
  visit_count       integer,
  last_visit        timestamptz,
  total_spent_cents bigint,
  total_count       bigint
)
language sql
security definer
set search_path = public
stable
as $$
  with bphones as (
    select distinct nullif(trim(b.client_phone), '') as phone
    from public.bookings b
    where b.salon_id = p_salon_id
  ),
  ids as (
    -- booking-derived (client may not have a backfilled profile yet)
    select bp.phone, cp.id as client_profile_id
    from bphones bp
    left join public.client_profiles cp
      on cp.phone = bp.phone and cp.deleted_at is null
    where bp.phone is not null
    union
    -- membership (always has a profile via FK)
    select cp.phone, cp.id
    from public.salon_clients sc
    join public.client_profiles cp
      on cp.id = sc.client_profile_id and cp.deleted_at is null
    where sc.salon_id = p_salon_id
  ),
  -- collapse to one row per phone (a phone maps to at most one profile)
  uniq as (
    select i.phone, max(i.client_profile_id::text)::uuid as client_profile_id
    from ids i
    where i.phone is not null
    group by i.phone
  ),
  named as (
    select
      u.client_profile_id,
      u.phone,
      coalesce(
        cp.name,
        (select b.client_name from public.bookings b
         where b.salon_id = p_salon_id and b.client_phone = u.phone
           and b.client_name is not null
         order by b.start_time_utc desc nulls last limit 1)
      ) as name,
      cp.email, cp.is_vip, cp.notes
    from uniq u
    left join public.client_profiles cp on cp.id = u.client_profile_id
  ),
  filtered as (
    select * from named n
    where p_search is null or p_search = ''
      or n.name ilike '%' || p_search || '%'
      or n.phone ilike '%' || p_search || '%'
      or (
        regexp_replace(p_search, '[^0-9]', '', 'g') <> ''
        and regexp_replace(coalesce(n.phone, ''), '[^0-9]', '', 'g')
            ilike '%' || regexp_replace(p_search, '[^0-9]', '', 'g') || '%'
      )
  ),
  counted as (select count(*)::bigint as total from filtered),
  page as (
    select * from filtered
    order by name nulls last, phone
    limit greatest(p_limit, 0) offset greatest(p_offset, 0)
  )
  select
    pg.client_profile_id,
    pg.phone,
    pg.name,
    pg.email,
    pg.is_vip,
    pg.notes,
    coalesce(agg.visits, 0)::integer as visit_count,
    agg.last_visit,
    coalesce(agg.spent, 0)::bigint as total_spent_cents,
    (select total from counted) as total_count
  from page pg
  left join lateral (
    select
      count(*) filter (where b.status in ('completed', 'confirmed')) as visits,
      max(b.start_time_utc) filter (where b.status in ('completed', 'confirmed')) as last_visit,
      sum(coalesce(b.price_cents, 0) + coalesce(b.addon_price_cents, 0))
        filter (where b.status = 'completed') as spent
    from public.bookings b
    where b.salon_id = p_salon_id and b.client_phone = pg.phone
  ) agg on true
  order by pg.name nulls last, pg.phone;
$$;

-- Dashboard-only: revoke from public, grant to service_role (the loader invokes
-- it via the service-role client after authenticating the viewer's role+salon).
revoke all on function public.search_salon_clients(uuid, text, int, int) from public;
grant execute on function public.search_salon_clients(uuid, text, int, int) to service_role;
