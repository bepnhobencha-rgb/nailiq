-- Realtime (postgres_changes): allow authenticated salon owners to receive booking INSERT/UPDATE
-- on the dashboard without full page reload. Requires table membership in `supabase_realtime`.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'bookings'
  ) then
    alter publication supabase_realtime add table public.bookings;
  end if;
end $$;
