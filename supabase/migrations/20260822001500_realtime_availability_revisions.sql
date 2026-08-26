-- Public booking clients need a tenant-scoped invalidation signal when an
-- owner changes staff shifts or one-off unavailability. Publishing the source
-- tables would expose their full change payload, so publish only this minimal
-- revision row and keep authoritative availability reads on the existing
-- security-invoker public views.

create table public.salon_availability_revisions (
  salon_id uuid primary key references public.salons(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  changed_at timestamptz not null default now()
);

alter table public.salon_availability_revisions enable row level security;

revoke all on table public.salon_availability_revisions from anon, authenticated;
grant select on table public.salon_availability_revisions to anon, authenticated;
grant all on table public.salon_availability_revisions to service_role;

create policy "public read active salon availability revisions"
on public.salon_availability_revisions
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.salons
    where salons.id = salon_availability_revisions.salon_id
      and salons.archived_at is null
  )
);

create or replace function public.bump_salon_availability_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_salon_id uuid;
begin
  target_salon_id := coalesce(new.salon_id, old.salon_id);

  insert into public.salon_availability_revisions (
    salon_id,
    revision,
    changed_at
  ) values (
    target_salon_id,
    1,
    now()
  )
  on conflict (salon_id) do update
  set revision = public.salon_availability_revisions.revision + 1,
      changed_at = excluded.changed_at;

  return coalesce(new, old);
end;
$$;

revoke all on function public.bump_salon_availability_revision() from public;
grant execute on function public.bump_salon_availability_revision() to service_role;

create trigger staff_shifts_bump_availability_revision
after insert or update or delete on public.staff_shifts
for each row execute function public.bump_salon_availability_revision();

create trigger staff_unavailability_bump_availability_revision
after insert or update or delete on public.staff_unavailability
for each row execute function public.bump_salon_availability_revision();

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'salon_availability_revisions'
  ) then
    alter publication supabase_realtime
      add table public.salon_availability_revisions;
  end if;
end
$$;

comment on table public.salon_availability_revisions is
  'Public, tenant-filterable Realtime invalidation only. Contains no staff schedule details or customer data.';
