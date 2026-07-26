-- staff_services: per-staff capability whitelist.
--
-- BACKWARD-COMPAT SEMANTIC (enforced at the application layer, not in SQL):
--   If a salon has ZERO rows in staff_services, every staff member is treated
--   as capable of every service. Once any row exists for that salon, the
--   whitelist becomes authoritative for that salon. This lets existing
--   salons keep working without data backfill.
--
-- See: src/shared/booking/staffCapability.ts (the canonical fallback rule)
-- and: salon_has_staff_services(uuid) helper below.

create table if not exists public.staff_services (
  staff_id   uuid not null references public.staff(id)    on delete cascade,
  service_id uuid not null references public.services(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (staff_id, service_id)
);

create index if not exists idx_staff_services_service
  on public.staff_services(service_id);
create index if not exists idx_staff_services_staff
  on public.staff_services(staff_id);

comment on table public.staff_services is
  'Per-staff capability whitelist. Empty for a salon == all-capable (see app fallback).';

alter table public.staff_services enable row level security;

-- Public booking page reads this anonymously to filter the staff step.
drop policy if exists "anon read staff_services" on public.staff_services;
create policy "anon read staff_services"
  on public.staff_services
  for select
  to anon, authenticated
  using (true);

-- Salon members may write rows where BOTH the staff and service belong to a
-- salon they are a member of.
drop policy if exists "members write staff_services" on public.staff_services;
create policy "members write staff_services"
  on public.staff_services
  for all
  to authenticated
  using (
    staff_id in (
      select s.id
      from public.staff s
      join public.salon_members m on m.salon_id = s.salon_id
      where m.user_id = auth.uid()
    )
  )
  with check (
    staff_id in (
      select s.id
      from public.staff s
      join public.salon_members m on m.salon_id = s.salon_id
      where m.user_id = auth.uid()
    )
    and service_id in (
      select sv.id
      from public.services sv
      join public.salon_members m on m.salon_id = sv.salon_id
      where m.user_id = auth.uid()
    )
  );

-- Defense in depth: prevent attaching a staff and service from different salons.
create or replace function public.staff_services_same_salon_trg() returns trigger
language plpgsql as $$
declare
  ss_salon uuid;
  sv_salon uuid;
begin
  select salon_id into ss_salon from public.staff    where id = new.staff_id;
  select salon_id into sv_salon from public.services where id = new.service_id;
  if ss_salon is null or sv_salon is null or ss_salon <> sv_salon then
    raise exception 'staff_services_cross_salon: staff % / service %',
      new.staff_id, new.service_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_staff_services_same_salon on public.staff_services;
create trigger trg_staff_services_same_salon
  before insert or update on public.staff_services
  for each row execute function public.staff_services_same_salon_trg();

-- Application helper: "does this salon have any staff_services rows?"
-- Used by server actions to decide whether to enforce the whitelist or fall
-- back to the all-capable rule. SECURITY DEFINER so the anonymous booking
-- path can also call it without needing direct read on staff/staff_services.
create or replace function public.salon_has_staff_services(p_salon_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.staff_services ss
    join public.staff s on s.id = ss.staff_id
    where s.salon_id = p_salon_id
    limit 1
  );
$$;

grant execute on function public.salon_has_staff_services(uuid) to anon, authenticated;
