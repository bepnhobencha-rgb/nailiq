-- Receptionist Center subscribes to tenant-filtered bookings changes and then
-- reloads the authoritative day through its authenticated server action. The
-- table already has RLS plus a salon_members-scoped authenticated SELECT
-- policy; publication membership only makes eligible changes available to
-- Realtime and does not weaken those row-visibility rules.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'bookings'
  ) then
    alter publication supabase_realtime
      add table public.bookings;
  end if;
end
$$;
